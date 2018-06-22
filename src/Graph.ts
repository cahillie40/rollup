import * as acorn from 'acorn';
import injectDynamicImportPlugin from 'acorn-dynamic-import/lib/inject';
import injectImportMeta from 'acorn-import-meta/inject';
import { Program } from 'estree';
import { EventEmitter } from 'events';
import GlobalScope from './ast/scopes/GlobalScope';
import { EntityPathTracker } from './ast/utils/EntityPathTracker';
import GlobalVariable from './ast/variables/GlobalVariable';
import Chunk from './Chunk';
import ExternalModule from './ExternalModule';
import Module, { defaultAcornOptions } from './Module';
import {
	Asset,
	InputOptions,
	IsExternal,
	ModuleJSON,
	OutputBundle,
	RollupCache,
	RollupWarning,
	SerializablePluginCache,
	SourceDescription,
	TreeshakingOptions,
	WarningHandler
} from './rollup/types';
import { finaliseAsset } from './utils/assetHooks';
import { Uint8ArrayToHexString } from './utils/entryHashing';
import error from './utils/error';
import { analyzeModuleExecution, sortByExecutionOrder } from './utils/execution-order';
import { isRelative, resolve } from './utils/path';
import { createPluginDriver, PluginDriver } from './utils/pluginDriver';
import relativeId, { getAliasName } from './utils/relativeId';
import { timeEnd, timeStart } from './utils/timers';
import transform from './utils/transform';

function makeOnwarn() {
	const warned = Object.create(null);

	return (warning: any) => {
		const str = warning.toString();
		if (str in warned) return;
		console.error(str); //eslint-disable-line no-console
		warned[str] = true;
	};
}

export default class Graph {
	curChunkIndex = 0;
	acornOptions: acorn.Options;
	acornParse: acorn.IParse;
	cachedModules: Map<string, ModuleJSON>;
	context: string;
	externalModules: ExternalModule[] = [];
	getModuleContext: (id: string) => string;
	hasLoaders: boolean;
	isPureExternalModule: (id: string) => boolean;
	moduleById = new Map<string, Module | ExternalModule>();
	assetsById = new Map<string, Asset>();
	modules: Module[] = [];
	onwarn: WarningHandler;
	deoptimizationTracker: EntityPathTracker;
	scope: GlobalScope;
	shimMissingExports: boolean;
	exportShimVariable: GlobalVariable;
	treeshakingOptions: TreeshakingOptions;
	varOrConst: 'var' | 'const';

	isExternal: IsExternal;

	contextParse: (code: string, acornOptions?: acorn.Options) => Program;

	pluginDriver: PluginDriver;
	pluginCache: Record<string, SerializablePluginCache>;
	watchFiles: Record<string, true> = Object.create(null);
	cacheExpiry: number;

	// track graph build status as each graph instance is used only once
	finished = false;

	// deprecated
	treeshake: boolean;

	constructor(options: InputOptions, watcher?: EventEmitter) {
		this.curChunkIndex = 0;
		this.deoptimizationTracker = new EntityPathTracker();
		this.cachedModules = new Map();
		if (options.cache) {
			if (options.cache.modules)
				for (const module of options.cache.modules) this.cachedModules.set(module.id, module);
		}
		if (options.cache !== false) {
			this.pluginCache = (options.cache && options.cache.plugins) || Object.create(null);

			// increment access counter
			for (const name in this.pluginCache) {
				const cache = this.pluginCache[name];
				for (const key of Object.keys(cache)) cache[key][0]++;
			}
		}

		this.cacheExpiry = options.experimentalCacheExpiry;

		if (!options.input) {
			throw new Error('You must supply options.input to rollup');
		}

		this.treeshake = options.treeshake !== false;
		if (this.treeshake) {
			this.treeshakingOptions = {
				propertyReadSideEffects: options.treeshake
					? (<TreeshakingOptions>options.treeshake).propertyReadSideEffects !== false
					: true,
				pureExternalModules: options.treeshake
					? (<TreeshakingOptions>options.treeshake).pureExternalModules
					: false
			};
			if (this.treeshakingOptions.pureExternalModules === true) {
				this.isPureExternalModule = () => true;
			} else if (typeof this.treeshakingOptions.pureExternalModules === 'function') {
				this.isPureExternalModule = this.treeshakingOptions.pureExternalModules;
			} else if (Array.isArray(this.treeshakingOptions.pureExternalModules)) {
				const pureExternalModules = new Set(this.treeshakingOptions.pureExternalModules);
				this.isPureExternalModule = id => pureExternalModules.has(id);
			} else {
				this.isPureExternalModule = () => false;
			}
		} else {
			this.isPureExternalModule = () => false;
		}

		this.contextParse = (code: string, options: acorn.Options = {}) => {
			return this.acornParse(code, { ...defaultAcornOptions, ...options, ...this.acornOptions });
		};

		this.pluginDriver = createPluginDriver(this, options, this.pluginCache, watcher);

		if (watcher) {
			const handleChange = (id: string) => this.pluginDriver.hookSeqSync('watchChange', [id]);
			watcher.on('change', handleChange);
			watcher.once('restart', () => {
				watcher.removeListener('change', handleChange);
			});
		}

		if (typeof options.external === 'function') {
			const external = options.external;
			this.isExternal = (id, parentId, isResolved) =>
				!id.startsWith('\0') && external(id, parentId, isResolved);
		} else {
			const external = options.external;
			const ids = new Set(Array.isArray(external) ? external : external ? [external] : []);
			this.isExternal = id => ids.has(id);
		}

		this.shimMissingExports = options.shimMissingExports;

		this.scope = new GlobalScope();
		// TODO strictly speaking, this only applies with non-ES6, non-default-only bundles
		for (const name of ['module', 'exports', '_interopDefault']) {
			this.scope.findVariable(name); // creates global variable as side-effect
		}
		this.exportShimVariable = this.scope.findVariable('_missingExportShim');

		this.context = String(options.context);

		const optionsModuleContext = options.moduleContext;
		if (typeof optionsModuleContext === 'function') {
			this.getModuleContext = id => optionsModuleContext(id) || this.context;
		} else if (typeof optionsModuleContext === 'object') {
			const moduleContext = new Map();
			for (const key in optionsModuleContext) {
				moduleContext.set(resolve(key), optionsModuleContext[key]);
			}
			this.getModuleContext = id => moduleContext.get(id) || this.context;
		} else {
			this.getModuleContext = () => this.context;
		}

		this.onwarn = options.onwarn || makeOnwarn();

		this.varOrConst = options.preferConst ? 'const' : 'var';

		this.acornOptions = options.acorn || {};
		const acornPluginsToInject = [];

		acornPluginsToInject.push(injectDynamicImportPlugin);
		acornPluginsToInject.push(injectImportMeta);
		this.acornOptions.plugins = this.acornOptions.plugins || {};
		this.acornOptions.plugins.dynamicImport = true;
		this.acornOptions.plugins.importMeta = true;

		if (options.experimentalTopLevelAwait) {
			(<any>this.acornOptions).allowAwaitOutsideFunction = true;
		}

		const acornInjectPlugins = options.acornInjectPlugins;
		acornPluginsToInject.push(
			...(Array.isArray(acornInjectPlugins)
				? acornInjectPlugins
				: acornInjectPlugins
					? [acornInjectPlugins]
					: [])
		);
		this.acornParse = acornPluginsToInject.reduce((acc, plugin) => plugin(acc), acorn).parse;
	}

	getCache(): RollupCache {
		// handle plugin cache eviction
		for (const name in this.pluginCache) {
			const cache = this.pluginCache[name];
			let allDeleted = true;
			for (const key of Object.keys(cache)) {
				if (cache[key][0] >= this.cacheExpiry) delete cache[key];
				else allDeleted = false;
			}
			if (allDeleted) delete this.pluginCache[name];
		}

		return <any>{
			modules: this.modules.map(module => module.toJSON()),
			plugins: this.pluginCache
		};
	}

	finaliseAssets(assetFileNames: string) {
		const outputBundle: OutputBundle = Object.create(null);
		this.assetsById.forEach(asset => {
			if (asset.source !== undefined) finaliseAsset(asset, outputBundle, assetFileNames);
		});
		return outputBundle;
	}

	private loadModule(entryName: string) {
		return this.pluginDriver
			.hookFirst<string | boolean | void>('resolveId', [entryName, undefined])
			.then(id => {
				if (id === false) {
					error({
						code: 'UNRESOLVED_ENTRY',
						message: `Entry module cannot be external`
					});
				}

				if (id == null) {
					error({
						code: 'UNRESOLVED_ENTRY',
						message: `Could not resolve entry (${entryName})`
					});
				}

				return this.fetchModule(<string>id, undefined);
			});
	}

	private link() {
		for (const module of this.modules) {
			module.linkDependencies();
		}
		for (const module of this.modules) {
			module.bindReferences();
		}
	}

	includeMarked(modules: Module[]) {
		if (this.treeshake) {
			let needsTreeshakingPass,
				treeshakingPass = 1;
			do {
				timeStart(`treeshaking pass ${treeshakingPass}`, 3);
				needsTreeshakingPass = false;
				for (const module of modules) {
					if (module.include()) {
						needsTreeshakingPass = true;
					}
				}
				timeEnd(`treeshaking pass ${treeshakingPass++}`, 3);
			} while (needsTreeshakingPass);
		} else {
			// Necessary to properly replace namespace imports
			for (const module of modules) module.includeAllInBundle();
		}
	}

	private loadEntryModules(
		entryModules: string | string[] | Record<string, string>,
		manualChunks: Record<string, string[]> | void
	) {
		let removeAliasExtensions = false;
		let entryModuleIds: string[];
		let entryModuleAliases: string[];
		if (typeof entryModules === 'string') entryModules = [entryModules];

		if (Array.isArray(entryModules)) {
			removeAliasExtensions = true;
			entryModuleAliases = entryModules.concat([]);
			entryModuleIds = entryModules;
		} else {
			entryModuleAliases = Object.keys(entryModules);
			entryModuleIds = entryModuleAliases.map(name => (<Record<string, string>>entryModules)[name]);
		}

		const entryAndManualChunkIds = entryModuleIds.concat([]);
		if (manualChunks) {
			Object.keys(manualChunks).forEach(name => {
				const manualChunkIds = manualChunks[name];
				manualChunkIds.forEach(id => {
					if (entryAndManualChunkIds.indexOf(id) === -1) entryAndManualChunkIds.push(id);
				});
			});
		}

		return Promise.all(entryAndManualChunkIds.map(id => this.loadModule(id))).then(
			entryAndChunkModules => {
				if (removeAliasExtensions) {
					for (let i = 0; i < entryModuleAliases.length; i++)
						entryModuleAliases[i] = getAliasName(entryAndChunkModules[i].id, entryModuleAliases[i]);
				}

				const entryModules = entryAndChunkModules.slice(0, entryModuleIds.length);

				let manualChunkModules: { [chunkName: string]: Module[] };
				if (manualChunks) {
					manualChunkModules = {};
					for (const chunkName of Object.keys(manualChunks)) {
						const chunk = manualChunks[chunkName];
						manualChunkModules[chunkName] = chunk.map(entryId => {
							const entryIndex = entryAndManualChunkIds.indexOf(entryId);
							return entryAndChunkModules[entryIndex];
						});
					}
				}

				return { entryModules, entryModuleAliases, manualChunkModules };
			}
		);
	}

	build(
		entryModules: string | string[] | Record<string, string>,
		manualChunks: Record<string, string[]> | void,
		inlineDynamicImports: boolean,
		preserveModules: boolean
	): Promise<Chunk[]> {
		// Phase 1 – discovery. We load the entry module and find which
		// modules it imports, and import those, until we have all
		// of the entry module's dependencies

		timeStart('parse modules', 2);

		return this.loadEntryModules(entryModules, manualChunks).then(
			({ entryModules, entryModuleAliases, manualChunkModules }) => {
				timeEnd('parse modules', 2);

				// Phase 2 - linking. We populate the module dependency links and
				// determine the topological execution order for the bundle
				timeStart('analyse dependency graph', 2);

				for (let i = 0; i < entryModules.length; i++) {
					const entryModule = entryModules[i];
					const duplicateIndex = entryModules.indexOf(entryModule, i + 1);
					if (duplicateIndex !== -1) {
						error({
							code: 'DUPLICATE_ENTRY_POINTS',
							message: `Duplicate entry points detected. The input entries ${
								entryModuleAliases[i]
							} and ${entryModuleAliases[duplicateIndex]} both point to the same module, ${
								entryModule.id
							}`
						});
					}
				}

				this.link();

				const {
					orderedModules,
					dynamicImports,
					dynamicImportAliases,
					cyclePaths
				} = analyzeModuleExecution(
					entryModules,
					!preserveModules && !inlineDynamicImports,
					inlineDynamicImports,
					manualChunkModules
				);
				for (const cyclePath of cyclePaths) {
					this.warn({
						code: 'CIRCULAR_DEPENDENCY',
						importer: cyclePath[0],
						message: `Circular dependency: ${cyclePath.join(' -> ')}`
					});
				}

				if (entryModuleAliases) {
					for (let i = entryModules.length - 1; i >= 0; i--) {
						entryModules[i].chunkAlias = entryModuleAliases[i];
					}
				}

				if (inlineDynamicImports) {
					const entryModule = entryModules[0];
					if (entryModules.length > 1)
						throw new Error(
							'Internal Error: can only inline dynamic imports for single-file builds.'
						);
					for (const dynamicImportModule of dynamicImports) {
						if (entryModule !== dynamicImportModule) dynamicImportModule.markPublicExports();
						dynamicImportModule.getOrCreateNamespace().include();
					}
				} else {
					for (let i = 0; i < dynamicImports.length; i++) {
						const dynamicImportModule = dynamicImports[i];
						if (entryModules.indexOf(dynamicImportModule) === -1) {
							entryModules.push(dynamicImportModule);
							if (!dynamicImportModule.chunkAlias)
								dynamicImportModule.chunkAlias = dynamicImportAliases[i];
						}
					}
				}

				timeEnd('analyse dependency graph', 2);

				// Phase 3 – marking. We include all statements that should be included
				timeStart('mark included statements', 2);

				for (const entryModule of entryModules) entryModule.markPublicExports();

				// only include statements that should appear in the bundle
				this.includeMarked(orderedModules);

				// check for unused external imports
				for (const externalModule of this.externalModules) externalModule.warnUnusedImports();

				timeEnd('mark included statements', 2);

				// Phase 4 – we construct the chunks, working out the optimal chunking using
				// entry point graph colouring, before generating the import and export facades
				timeStart('generate chunks', 2);

				// TODO: there is one special edge case unhandled here and that is that any module
				//       exposed as an unresolvable export * (to a graph external export *,
				//       either as a namespace import reexported or top-level export *)
				//       should be made to be its own entry point module before chunking
				let chunks: Chunk[] = [];
				if (preserveModules) {
					for (const module of orderedModules) {
						const chunk = new Chunk(this, [module]);
						if (module.isEntryPoint || !chunk.isEmpty) chunk.entryModule = module;
						chunks.push(chunk);
					}
				} else {
					const chunkModules: { [entryHashSum: string]: Module[] } = {};
					for (const module of orderedModules) {
						const entryPointsHashStr = Uint8ArrayToHexString(module.entryPointsHash);
						const curChunk = chunkModules[entryPointsHashStr];
						if (curChunk) {
							curChunk.push(module);
						} else {
							chunkModules[entryPointsHashStr] = [module];
						}
					}

					for (const entryHashSum in chunkModules) {
						const chunkModulesOrdered = chunkModules[entryHashSum];
						sortByExecutionOrder(chunkModulesOrdered);
						const chunk = new Chunk(this, chunkModulesOrdered);
						chunks.push(chunk);
					}
				}

				// for each chunk module, set up its imports to other
				// chunks, if those variables are included after treeshaking
				for (const chunk of chunks) {
					chunk.link();
				}

				// filter out empty dependencies
				chunks = chunks.filter(chunk => !chunk.isEmpty || chunk.entryModule || chunk.isManualChunk);

				// then go over and ensure all entry chunks export their variables
				for (const chunk of chunks) {
					if (preserveModules || chunk.entryModule) {
						chunk.populateEntryExports(preserveModules);
					}
				}

				// create entry point facades for entry module chunks that have tainted exports
				if (!preserveModules) {
					for (const entryModule of entryModules) {
						if (!entryModule.chunk.isEntryModuleFacade) {
							const entryPointFacade = new Chunk(this, []);
							entryPointFacade.linkFacade(entryModule);
							chunks.push(entryPointFacade);
						}
					}
				}

				timeEnd('generate chunks', 2);

				this.finished = true;
				return chunks;
			}
		);
	}

	private fetchModule(id: string, importer: string): Promise<Module> {
		// short-circuit cycles
		const existingModule = this.moduleById.get(id);
		if (existingModule) {
			if (existingModule.isExternal) throw new Error(`Cannot fetch external module ${id}`);
			return Promise.resolve(<Module>existingModule);
		}

		const module: Module = new Module(this, id);
		this.moduleById.set(id, module);
		this.watchFiles[id] = true;

		timeStart('load modules', 3);
		return Promise.resolve(this.pluginDriver.hookFirst('load', [id]))
			.catch((err: Error) => {
				timeEnd('load modules', 3);
				let msg = `Could not load ${id}`;
				if (importer) msg += ` (imported by ${importer})`;

				msg += `: ${err.message}`;
				throw new Error(msg);
			})
			.then(source => {
				timeEnd('load modules', 3);
				if (typeof source === 'string') return source;
				if (source && typeof source === 'object' && typeof source.code === 'string') return source;

				// TODO report which plugin failed
				error({
					code: 'BAD_LOADER',
					message: `Error loading ${relativeId(
						id
					)}: plugin load hook should return a string, a { code, map } object, or nothing/null`
				});
			})
			.then(source => {
				const sourceDescription: SourceDescription =
					typeof source === 'string'
						? {
								code: source,
								ast: null
						  }
						: source;

				const cachedModule = this.cachedModules.get(id);
				if (
					cachedModule &&
					!cachedModule.customTransformCache &&
					cachedModule.originalCode === sourceDescription.code
				) {
					// re-emit transform assets
					if (cachedModule.transformAssets) {
						for (const asset of cachedModule.transformAssets)
							this.pluginDriver.emitAsset(asset.name, asset.source);
					}
					return cachedModule;
				}

				return transform(this, sourceDescription, module);
			})
			.then((source: ModuleJSON) => {
				module.setSource(source);

				this.modules.push(module);
				this.moduleById.set(id, module);

				return this.fetchAllDependencies(module).then(() => {
					for (const name in module.exports) {
						if (name !== 'default') {
							module.exportsAll[name] = module.id;
						}
					}
					module.exportAllSources.forEach(source => {
						const id = module.resolvedIds[source];
						const exportAllModule = this.moduleById.get(id);
						if (exportAllModule.isExternal) return;

						for (const name in (<Module>exportAllModule).exportsAll) {
							if (name in module.exportsAll) {
								this.warn({
									code: 'NAMESPACE_CONFLICT',
									reexporter: module.id,
									name,
									sources: [module.exportsAll[name], (<Module>exportAllModule).exportsAll[name]],
									message: `Conflicting namespaces: ${relativeId(
										module.id
									)} re-exports '${name}' from both ${relativeId(
										module.exportsAll[name]
									)} and ${relativeId(
										(<Module>exportAllModule).exportsAll[name]
									)} (will be ignored)`
								});
							} else {
								module.exportsAll[name] = (<Module>exportAllModule).exportsAll[name];
							}
						}
					});
					return module;
				});
			});
	}

	private fetchAllDependencies(module: Module) {
		// resolve and fetch dynamic imports where possible
		const fetchDynamicImportsPromise = Promise.all(
			module.getDynamicImportExpressions().map((dynamicImportExpression, index) => {
				return Promise.resolve(
					this.pluginDriver.hookFirst('resolveDynamicImport', [dynamicImportExpression, module.id])
				).then(replacement => {
					if (!replacement) {
						module.dynamicImportResolutions[index] = {
							alias: undefined,
							resolution: undefined
						};
						return;
					}
					const alias = getAliasName(
						replacement,
						typeof dynamicImportExpression === 'string' ? dynamicImportExpression : undefined
					);
					if (typeof dynamicImportExpression !== 'string') {
						module.dynamicImportResolutions[index] = { alias, resolution: replacement };
					} else if (this.isExternal(replacement, module.id, true)) {
						let externalModule;
						if (!this.moduleById.has(replacement)) {
							externalModule = new ExternalModule({
								graph: this,
								id: replacement
							});
							this.externalModules.push(externalModule);
							this.moduleById.set(replacement, module);
						} else {
							externalModule = <ExternalModule>this.moduleById.get(replacement);
						}
						module.dynamicImportResolutions[index] = { alias, resolution: externalModule };
						externalModule.exportsNamespace = true;
					} else {
						return this.fetchModule(replacement, module.id).then(depModule => {
							module.dynamicImportResolutions[index] = { alias, resolution: depModule };
						});
					}
				});
			})
		).then(() => {});
		fetchDynamicImportsPromise.catch(() => {});

		return Promise.all(
			module.sources.map(source => {
				return Promise.resolve()
					.then(() => {
						const resolvedId = module.resolvedIds[source];
						if (resolvedId) return resolvedId;
						if (this.isExternal(source, module.id, false)) return false;
						return this.pluginDriver.hookFirst<string | boolean | void>('resolveId', [
							source,
							module.id
						]);
					})
					.then(resolvedId => {
						// TODO types of `resolvedId` are not compatible with 'externalId'.
						// `this.resolveId` returns `string`, `void`, and `boolean`
						const externalId =
							<string>resolvedId ||
							(isRelative(source) ? resolve(module.id, '..', source) : source);
						let isExternal = resolvedId === false || this.isExternal(externalId, module.id, true);

						if (!resolvedId && !isExternal) {
							if (isRelative(source)) {
								error({
									code: 'UNRESOLVED_IMPORT',
									message: `Could not resolve '${source}' from ${relativeId(module.id)}`
								});
							}

							if (resolvedId !== false) {
								this.warn({
									code: 'UNRESOLVED_IMPORT',
									source,
									importer: relativeId(module.id),
									message: `'${source}' is imported by ${relativeId(
										module.id
									)}, but could not be resolved – treating it as an external dependency`,
									url:
										'https://rollupjs.org/guide/en#warning-treating-module-as-external-dependency'
								});
							}
							isExternal = true;
						}

						if (isExternal) {
							module.resolvedIds[source] = externalId;

							if (!this.moduleById.has(externalId)) {
								const module = new ExternalModule({ graph: this, id: externalId });
								this.externalModules.push(module);
								this.moduleById.set(externalId, module);
							}

							const externalModule = this.moduleById.get(externalId);

							if (externalModule instanceof ExternalModule === false) {
								error({
									code: 'INVALID_EXTERNAL_ID',
									message: `'${source}' is imported as an external by ${relativeId(
										module.id
									)}, but is already an existing non-external module id.`
								});
							}

							// add external declarations so we can detect which are never used
							for (const name in module.imports) {
								const importDeclaration = module.imports[name];
								if (importDeclaration.source !== source) return;

								externalModule.traceExport(importDeclaration.name);
							}
						} else {
							module.resolvedIds[source] = <string>resolvedId;
							return this.fetchModule(<string>resolvedId, module.id);
						}
					});
			})
		).then(() => fetchDynamicImportsPromise);
	}

	warn(warning: RollupWarning) {
		warning.toString = () => {
			let str = '';

			if (warning.plugin) str += `(${warning.plugin} plugin) `;
			if (warning.loc)
				str += `${relativeId(warning.loc.file)} (${warning.loc.line}:${warning.loc.column}) `;
			str += warning.message;

			return str;
		};

		this.onwarn(warning);
	}
}
