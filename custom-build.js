const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { rollup } = require('rollup');
const Terser = require('terser');
const sass = require('sass');
const CleanCSS = require('clean-css');

// AST parsing dependencies
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

// --- Configuration ---
const DEFAULT_CONFIG = {
    appJsonPath: './app.json',
    workspaceJsonPath: './workspace.json',
    buildDir: './build/production/MyApp',
    buildProfile: 'production', // 'development' | 'testing' | 'production'
    indexPath: './index.html',
    extPath: './ext',
    minifyJs: true,
    minifyCss: true,
    generateSourceMaps: false,
    compressResources: true,
    forceMinimalCore: false // New option
};

// --- Globals ---
const dependencyGraph = new Map();
const discoveredFiles = new Set();
const classToFileMap = new Map();
const fileContentCache = new Map();

// --- AST Parsing Utilities ---

// --- Minification ---
async function minifyJs(code, sourceFileName) {
    console.log(`   - Minifying JavaScript (${sourceFileName})...`);
    try {
        const result = await Terser.minify(code, {
            mangle: true,
            compress: true
        });
        return result.code;
    } catch (error) {
        console.error(`Error during JS minification of ${sourceFileName}:`, error);
        throw error; // Re-throw to halt the build or handle appropriately
    }
}

function parseJavaScript(code, filePath) {
    try {
        return parse(code, {
            sourceType: 'module',
            allowImportExportEverywhere: true,
            allowReturnOutsideFunction: true,
            plugins: [
                'jsx',
                'flow',
                'doExpressions',
                'objectRestSpread',
                'decorators-legacy',
                'classProperties',
                'asyncGenerators',
                'functionBind',
                'exportDefaultFrom',
                'exportNamespaceFrom',
                'dynamicImport',
                'nullishCoalescingOperator',
                'optionalChaining'
            ]
        });
    } catch (error) {
        console.warn(`⚠️  Failed to parse ${filePath}: ${error.message}`);
        return null;
    }
}

function extractStringLiteral(node) {
    if (t.isStringLiteral(node)) {
        return node.value;
    }
    if (t.isTemplateLiteral(node) && node.quasis.length === 1) {
        return node.quasis[0].value.cooked;
    }
    return null;
}

function extractArrayOfStrings(node) {
    if (!t.isArrayExpression(node)) {
        return [];
    }
    
    const strings = [];
    for (const element of node.elements) {
        const str = extractStringLiteral(element);
        if (str) {
            strings.push(str);
        }
    }
    return strings;
}

function findObjectProperty(objectExpression, propertyName) {
    if (!t.isObjectExpression(objectExpression)) {
        return null;
    }
    
    for (const prop of objectExpression.properties) {
        if (t.isObjectProperty(prop)) {
            let key = null;
            if (t.isIdentifier(prop.key)) {
                key = prop.key.name;
            } else if (t.isStringLiteral(prop.key)) {
                key = prop.key.value;
            }
            
            if (key === propertyName) {
                return prop.value;
            }
        }
    }
    return null;
}

function analyzeExtDefine(ast) {
    const results = [];
    
    traverse(ast, {
        CallExpression(path) {
            const { node } = path;
            
            // Look for Ext.define calls
            if (t.isMemberExpression(node.callee) &&
                t.isIdentifier(node.callee.object, { name: 'Ext' }) &&
                t.isIdentifier(node.callee.property, { name: 'define' })) {
                
                if (node.arguments.length >= 2) {
                    const className = extractStringLiteral(node.arguments[0]);
                    const configObject = node.arguments[1];
                    
                    if (className && t.isObjectExpression(configObject)) {
                        const dependencies = extractDependenciesFromConfig(configObject);
                        results.push({
                            type: 'define',
                            className,
                            dependencies,
                            node: configObject
                        });
                    }
                }
            }
        }
    });
    
    return results;
}

function analyzeExtApplication(ast) {
    const results = [];
    
    traverse(ast, {
        CallExpression(path) {
            const { node } = path;
            
            // Look for Ext.application calls
            if (t.isMemberExpression(node.callee) &&
                t.isIdentifier(node.callee.object, { name: 'Ext' }) &&
                t.isIdentifier(node.callee.property, { name: 'application' })) {
                
                if (node.arguments.length >= 1) {
                    const configObject = node.arguments[0];
                    
                    if (t.isObjectExpression(configObject)) {
                        const dependencies = extractDependenciesFromConfig(configObject);
                        const extendValue = findObjectProperty(configObject, 'extend');
                        const extend = extractStringLiteral(extendValue);
                        
                        results.push({
                            type: 'application',
                            extend,
                            dependencies,
                            node: configObject
                        });
                    }
                }
            }
        }
    });
    
    return results;
}

function extractDependenciesFromConfig(configObject) {
    const dependencies = [];
    
    // Extract 'extend'
    const extendValue = findObjectProperty(configObject, 'extend');
    const extend = extractStringLiteral(extendValue);
    if (extend) {
        dependencies.push(extend);
    }
    
    // Extract 'overrides'
    const overridesValue = findObjectProperty(configObject, 'overrides');
    const overrides = extractStringLiteral(overridesValue);
    if (overrides) {
        dependencies.push(overrides);
    }
    
    // Extract 'mainView'
    const mainViewValue = findObjectProperty(configObject, 'mainView');
    const mainView = extractStringLiteral(mainViewValue);
    if (mainView) {
        dependencies.push(mainView);
    }
    
    // Extract 'requires'
    const requiresValue = findObjectProperty(configObject, 'requires');
    if (requiresValue) {
        const requires = extractArrayOfStrings(requiresValue);
        dependencies.push(...requires);
    }
    
    // Extract 'uses'
    const usesValue = findObjectProperty(configObject, 'uses');
    if (usesValue) {
        const uses = extractArrayOfStrings(usesValue);
        dependencies.push(...uses);
    }
    
    // Extract stores array
    const storesValue = findObjectProperty(configObject, 'stores');
    if (storesValue) {
        const stores = extractArrayOfStrings(storesValue);
        dependencies.push(...stores);
    }
    
    // Extract models array
    const modelsValue = findObjectProperty(configObject, 'models');
    if (modelsValue) {
        const models = extractArrayOfStrings(modelsValue);
        dependencies.push(...models);
    }
    
    // Extract controllers array
    const controllersValue = findObjectProperty(configObject, 'controllers');
    if (controllersValue) {
        const controllers = extractArrayOfStrings(controllersValue);
        dependencies.push(...controllers);
    }
    
    return dependencies.filter(dep => dep && dep.trim());
}

function normalizeClassName(className) {
    return className ? className.trim() : '';
}

// --- Utility Functions ---

function generateHash(content) {
    return crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
}

// --- Configuration Loading ---

async function loadAppJson(filePath) {
    try {
        if (await fs.pathExists(filePath)) {
            let content = await fs.readFile(filePath, 'utf-8');
            
            // Remove JSON comments (/* */ and //)
            content = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
            
            try {
                const config = JSON.parse(content);
                console.log(`📄 Loaded app configuration from ${filePath}`);
                return config;
            } catch (jsonError) {
                console.log(`❌ JSON parsing error in ${filePath}:`);
                console.log(`   Error: ${jsonError.message}`);
                console.log(`   Content preview:\n${content.substring(0, 300)}...`);
                console.log(`💡 Please fix the JSON syntax errors in ${filePath}`);
            }
        }
    } catch (e) {
        console.warn(`⚠️  Could not load app.json from ${filePath}: ${e.message}`);
    }
    
    // Return default configuration
    console.log(`📄 Using default app configuration`);
    return {
        name: "CMDAPP",
        namespace: "CMDAPP", 
        toolkit: "classic",
        theme: "theme-triton",
        requires: ["font-awesome"],
        classpath: ["app"],
        overrides: ["overrides"],
        sass: {
            namespace: "CMDAPP",
            etc: ["sass/etc/all.scss"],
            var: ["sass/var/all.scss"],
            src: ["sass/src/all.scss"]
        },
        resources: [
            { path: "resources", output: "shared" }
        ],
        output: {
            base: "${workspace.build.dir}/${build.environment}/${app.name}",
            page: "index.html",
            manifest: "${build.id}.json",
            js: "${build.id}/app.js",
            appCache: { enable: false },
            resources: { path: "${build.id}/resources", shared: "resources" }
        }
    };
}

async function loadWorkspaceJson(filePath) {
    try {
        if (await fs.pathExists(filePath)) {
            let content = await fs.readFile(filePath, 'utf-8');
            
            // Remove JSON comments (/* */ and //)
            content = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
            
            try {
                const config = JSON.parse(content);
                console.log(`📄 Loaded workspace configuration from ${filePath}`);
                return config;
            } catch (jsonError) {
                console.log(`❌ JSON parsing error in ${filePath}:`);
                console.log(`   Error: ${jsonError.message}`);
                console.log(`   Content preview:\n${content.substring(0, 300)}...`);
                console.log(`💡 Please fix the JSON syntax errors in ${filePath}`);
            }
        }
    } catch (e) {
        console.warn(`⚠️  Could not load workspace.json from ${filePath}: ${e.message}`);
    }
    
    console.log(`📄 Using default workspace configuration`);
    return {
        frameworks: {
            ext: { path: "ext", version: "7.0.0" }
        },
        packages: {
            dir: "${workspace.dir}/packages/local,${workspace.dir}/packages",
            extract: "${workspace.dir}/packages/remote"
        },
        build: {
            dir: "${workspace.dir}/build"
        }
    };
}

// --- File Discovery ---

async function buildFileIndex(jsPaths, extPath, packagePaths = []) {
    const fileIndex = new Map(); // className -> filePath
    const searchPaths = [...jsPaths, ...packagePaths];
    
    console.log('🔍 Building file index using AST parsing...');
    
    // Debug: Check ExtJS directory structure
    if (extPath && await fs.pathExists(extPath)) {
        console.log(`📂 Checking ExtJS SDK structure at: ${extPath}`);
        
        // Focus on the key directories we know exist
        const extSrcPaths = [
            { path: path.join(extPath, 'classic', 'classic', 'src'), name: 'classic/classic/src' },
            { path: path.join(extPath, 'packages', 'core', 'src'), name: 'packages/core/src' },
            { path: path.join(extPath, 'packages'), name: 'packages' }
        ];
        
        for (const srcInfo of extSrcPaths) {
            if (await fs.pathExists(srcInfo.path)) {
                console.log(`✅ Indexing ExtJS: ${srcInfo.name}`);
                await indexJsFilesInDirectory(srcInfo.path, true, fileIndex);
            } else {
                console.log(`❌ ExtJS source path not found: ${srcInfo.name}`);
            }
        }
    }
    
    // Index application files
    for (const searchPath of searchPaths) {
        if (await fs.pathExists(searchPath)) {
            console.log(`📂 Indexing app files in: ${path.relative(process.cwd(), searchPath)}`);
            await indexJsFilesInDirectory(searchPath, false, fileIndex);
        }
    }
    
    console.log(`📝 Total classes indexed: ${fileIndex.size}`);
    
    // Debug: Show breakdown and check for specific missing classes
    const extjsClasses = Array.from(fileIndex.entries()).filter(([name, info]) => info.isExtJS);
    const appClasses = Array.from(fileIndex.entries()).filter(([name, info]) => !info.isExtJS);
    
    console.log(`   ExtJS classes: ${extjsClasses.length}`);
    console.log(`   App classes: ${appClasses.length}`);
    
    // Specifically check if Ext.container.Container is indexed
    if (fileIndex.has('Ext.container.Container')) {
        console.log(`✅ Ext.container.Container IS indexed`);
    } else {
        console.log(`❌ Ext.container.Container NOT indexed`);
        
        // Look for any container-related classes that were indexed
        const containerClasses = Array.from(fileIndex.keys()).filter(name => name.includes('container'));
        if (containerClasses.length > 0) {
            console.log(`   Container-related classes found: ${containerClasses.slice(0, 10).join(', ')}`);
        }
    }
    
    return fileIndex;
}

async function indexJsFilesInDirectory(dirPath, isExtJS, fileIndex) {
    let indexedCount = 0;
    
    async function walkDir(currentPath) {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            
            if (entry.isDirectory()) {
                // Skip certain directories
                if (!['node_modules', '.git', 'build', 'temp'].includes(entry.name)) {
                    await walkDir(fullPath);
                }
            } else if (entry.isFile() && entry.name.endsWith('.js')) {
                // Parse file using AST to extract class name
                try {
                    const content = await fs.readFile(fullPath, 'utf-8');
                    const ast = parseJavaScript(content, fullPath);
                    
                    if (!ast) {
                        continue;
                    }
                    
                    let className = null;
                    
                    // Look for Ext.define calls
                    const defineResults = analyzeExtDefine(ast);
                    if (defineResults.length > 0) {
                        className = defineResults[0].className;
                    }
                    
                    // For ExtJS files, try to infer from file path as fallback
                    if (!className && isExtJS) {
                        const relativePath = path.relative(dirPath, fullPath);
                        
                        // Handle different ExtJS directory structures
                        let pathParts = relativePath.replace(/\.js$/, '').split(path.sep);
                        
                        // Remove common directory prefixes
                        if (pathParts[0] === 'src') pathParts = pathParts.slice(1);
                        if (pathParts[0] === 'classic') pathParts = pathParts.slice(1);
                        if (pathParts[0] === 'modern') pathParts = pathParts.slice(1);
                        
                        if (pathParts.length > 0) {
                            className = 'Ext.' + pathParts.join('.');
                            
                            // Special handling for core package
                            if (relativePath.includes('packages/core/src/')) {
                                const corePath = relativePath.split('packages/core/src/')[1];
                                className = 'Ext.' + corePath.replace(/\.js$/, '').split(path.sep).join('.');
                            }
                        }
                    }
                    
                    if (className) {
                        fileIndex.set(className, {
                            path: fullPath,
                            isExtJS: isExtJS,
                            relativePath: path.relative(dirPath, fullPath)
                        });
                        indexedCount++;
                        
                        // Debug: Log key ExtJS classes and Container specifically
                        if (isExtJS && (className === 'Ext.app.Application' || className === 'Ext.Component' || className === 'Ext.Base' || className === 'Ext.container.Container' || className.includes('Application'))) {
                            console.log(`  🎯 Found key ExtJS class: ${className} at ${path.relative(process.cwd(), fullPath)}`);
                        }
                    } else if (fullPath.includes('Container.js') || fullPath.includes('Application.js') || fullPath.includes('Component.js')) {
                        // For important ExtJS files that we can't parse, show more info
                        console.log(`   ❓ Could not determine class name for ${path.relative(process.cwd(), fullPath)}`);
                    }
                } catch (e) {
                    console.warn(`⚠️  Could not parse ${fullPath}: ${e.message}`);
                }
            }
        }
    }
    
    await walkDir(dirPath);
    
    if (isExtJS) {
        console.log(`  📂 ${path.relative(process.cwd(), dirPath)}: ${indexedCount} ExtJS classes indexed`);
    }
}

// --- Entry Point Discovery ---

async function findApplicationEntryPoint(jsPaths) {
    const possibleEntryPoints = [
        'app.js',           // Most common entry point
        'Application.js',
        'app/Application.js',
        ...jsPaths.map(p => path.join(p, 'Application.js'))
    ];
    
    for (const entryPoint of possibleEntryPoints) {
        if (await fs.pathExists(entryPoint)) {
            console.log(`🎯 Found application entry point: ${entryPoint}`);
            return entryPoint;
        }
    }
    
    throw new Error('Could not find app.js or Application.js entry point');
}

async function getEntryClassName(entryFilePath) {
    try {
        const content = await fs.readFile(entryFilePath, 'utf-8');
        
        console.log(`🔍 Analyzing entry file using AST: ${entryFilePath}`);
        console.log(`📄 File preview (first 500 chars):\n${content.substring(0, 500)}...`);
        
        const ast = parseJavaScript(content, entryFilePath);
        if (!ast) {
            throw new Error('Could not parse entry file as JavaScript');
        }
        
        // Check for Ext.application() call first
        const appResults = analyzeExtApplication(ast);
        if (appResults.length > 0) {
            const appResult = appResults[0];
            console.log(`✅ Found Ext.application() call`);
            
            if (appResult.extend) {
                console.log(`✅ Application extends: ${appResult.extend}`);
                return appResult.extend;
            }
            
            // If no extend, this might be an inline application
            console.log(`⚠️  Ext.application() found but no 'extend' property`);
            return '__INLINE_APPLICATION__';
        }
        
        // Check for Ext.define() 
        const defineResults = analyzeExtDefine(ast);
        if (defineResults.length > 0) {
            const className = defineResults[0].className;
            console.log(`✅ Found Ext.define: ${className}`);
            return className;
        }
        
        console.log(`❌ No ExtJS class/application definition found in ${entryFilePath}`);
        console.log(`💡 Expected: Ext.application({ extend: 'CMDAPP.Application', ... })`);
        console.log(`💡 Or: Ext.define('CMDAPP.Application', { ... })`);
        
        throw new Error('No Ext.define or Ext.application found in entry file');
    } catch (e) {
        throw new Error(`Could not determine entry class name: ${e.message}`);
    }
}

async function parseJsFile(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        fileContentCache.set(filePath, content);
        
        const ast = parseJavaScript(content, filePath);
        if (!ast) {
            return { filePath: filePath, classes: [], content: content };
        }
        
        const classes = [];
        
        // Analyze Ext.define calls
        const defineResults = analyzeExtDefine(ast);
        for (const result of defineResults) {
            classes.push({
                name: normalizeClassName(result.className),
                filePath: filePath,
                dependencies: result.dependencies,
                content: content
            });
            
            classToFileMap.set(result.className, filePath);
        }
        
        return {
            filePath: filePath,
            classes: classes,
            content: content
        };
    } catch (e) {
        console.warn(`⚠️  Error parsing ${filePath}: ${e.message}`);
        return { filePath: filePath, classes: [], content: '' };
    }
}

// --- Add Essential ExtJS Core Files ---

async function addExtJSCoreFiles(fileIndex, extPath, config) { // Pass full config
    console.log('🔧 Looking for ExtJS core files...');

    // First priority: Look for pre-built bundles, unless forceMinimalCore is true
    if (!config.forceMinimalCore) {
    const possibleBundles = [
        { path: 'build/ext-all-debug.js', name: 'ext-all-debug.js' },
        { path: 'build/ext-all.js', name: 'ext-all.js' },
        { path: 'ext-all-debug.js', name: 'ext-all-debug.js' },
        { path: 'ext-all.js', name: 'ext-all.js' },
        { path: 'ext.js', name: 'ext.js' },
    ];
    
    for (const bundleInfo of possibleBundles) {
        const bundlePath = path.join(extPath, bundleInfo.path);
        if (await fs.pathExists(bundlePath)) {
            const resolvedPath = path.resolve(bundlePath);
            console.log(`✅ Found ExtJS bundle: ${bundleInfo.name} at ${path.relative(process.cwd(), bundlePath)}`);
            
            try {
                const content = await fs.readFile(bundlePath, 'utf-8');
                fileContentCache.set(resolvedPath, content);
                
                const coreClassName = `__CORE_BUNDLE_${bundleInfo.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
                const coreFile = {
                    className: coreClassName,
                    filePath: resolvedPath,
                    isExtJS: true,
                    isCore: true,
                    priority: 0,
                    dependencies: [],
                    content: content
                };
                
                console.log(`📦 Using ${bundleInfo.name} as the main ExtJS bundle`);
                return [coreFile];
                
            } catch (e) {
                console.warn(`⚠️  Could not read bundle ${bundlePath}: ${e.message}`);
            }
        }
    }
    } else {
        console.log('ℹ️  `forceMinimalCore` is true. Skipping search for pre-built ExtJS bundles.');
    }
    
    // Second priority: Create a minimal ExtJS bootstrap
    // This will be used if no bundle was found OR if forceMinimalCore is true
    console.log('📦 Attempting to use or create minimal ExtJS bootstrap...');
    
    const bootstrapContent = await createMinimalExtJSBootstrap(extPath);
    if (bootstrapContent) {
        const bootstrapFile = {
            className: '__CORE_MINIMAL_BOOTSTRAP',
            filePath: '__minimal_bootstrap__',
            isExtJS: true,
            isCore: true,
            priority: 0,
            dependencies: [],
            content: bootstrapContent
        };
        
        console.log(`📦 Created minimal ExtJS bootstrap`);
        return [bootstrapFile];
    }
    
    // Fallback: Try to build from individual files (risky)
    console.log('⚠️  Falling back to individual core files (may not work correctly)...');
    return await collectIndividualCoreFiles(extPath);
}

async function createMinimalExtJSBootstrap(extPath) {
    console.log('🔧 Creating minimal ExtJS bootstrap...');
    
    // Key files needed for basic ExtJS functionality - EXPANDED LIST
    const criticalFiles = [
        'packages/core/src/Ext.js',
        'packages/core/src/lang/Array.js',
        'packages/core/src/lang/String.js', 
        'packages/core/src/lang/Function.js',
        'packages/core/src/lang/Object.js',
        'packages/core/src/lang/Date.js',
        'packages/core/src/class/Class.js', 
        'packages/core/src/class/Base.js',
        'packages/core/src/class/Mixin.js',
        'packages/core/src/class/ClassManager.js',
        'packages/core/src/Loader.js',
        'packages/core/src/GlobalEvents.js',
        'packages/core/src/util/Observable.js'
    ];
    
    const bootstrap = [];
    bootstrap.push('// Minimal ExtJS Bootstrap - Generated by Build Tool');
    bootstrap.push('// This creates the essential ExtJS infrastructure');
    bootstrap.push('');
    
    // Initialize global Ext object with more complete setup - NO STRICT MODE
    bootstrap.push('(function(global) {');
    bootstrap.push('    ');
    bootstrap.push('    // Create global Ext namespace');
    bootstrap.push('    var Ext = global.Ext = global.Ext || {};');
    bootstrap.push('    ');
    bootstrap.push('    // Basic Ext object structure');
    bootstrap.push('    Ext.global = global;');
    bootstrap.push('    Ext.emptyFn = function() {};');
    bootstrap.push('    Ext.identityFn = function(o) { return o; };');
    bootstrap.push('    Ext.isReady = false;');
    bootstrap.push('    Ext.readyListeners = [];');
    bootstrap.push('    ');
    bootstrap.push('    // Initialize basic browser detection');
    bootstrap.push('    Ext.isIE = /msie|trident/i.test(navigator.userAgent);');
    bootstrap.push('    Ext.isGecko = /gecko/i.test(navigator.userAgent);');
    bootstrap.push('    Ext.isWebKit = /webkit/i.test(navigator.userAgent);');
    bootstrap.push('    ');
    bootstrap.push('    // Basic execScript implementation for IE compatibility');
    bootstrap.push('    if (!global.execScript) {');
    bootstrap.push('        global.execScript = function(code) {');
    bootstrap.push('            return global.eval ? global.eval(code) : eval(code);');
    bootstrap.push('        };');
    bootstrap.push('    }');
    bootstrap.push('    ');
    bootstrap.push('    // Ensure execScript is available on Ext');
    bootstrap.push('    Ext.execScript = global.execScript || function(code) {');
    bootstrap.push('        return global.eval ? global.eval(code) : eval(code);');
    bootstrap.push('    };');
    bootstrap.push('    ');
    
    // Try to include critical ExtJS files
    let foundCriticalFiles = 0;
    for (const criticalFile of criticalFiles) {
        const filePath = path.join(extPath, criticalFile);
        if (await fs.pathExists(filePath)) {
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                bootstrap.push('    // === ' + path.basename(criticalFile) + ' ===');
                
                // Wrap the file content to ensure proper context
                if (criticalFile.includes('ClassManager.js')) {
                    // Special handling for ClassManager - ensure Ext.define is created
                    bootstrap.push('    // ClassManager setup - critical for Ext.define');
                    bootstrap.push('    (function() {');
                    bootstrap.push('        ' + content.replace(/\n/g, '\n        '));
                    bootstrap.push('    })();');
                    bootstrap.push('    ');
                    bootstrap.push('    // Ensure Ext.define is available');
                    bootstrap.push('    if (!Ext.define && Ext.ClassManager) {');
                    bootstrap.push('        Ext.define = Ext.ClassManager.create;');
                    bootstrap.push('    }');
                } else if (criticalFile.includes('Loader.js')) {
                    // Special handling for Loader - critical for dynamic loading
                    bootstrap.push('    // Loader setup - critical for dynamic loading');
                    bootstrap.push('    (function() {');
                    bootstrap.push('        ' + content.replace(/\n/g, '\n        '));
                    bootstrap.push('    })();');
                    bootstrap.push('    ');
                    bootstrap.push('    // Ensure Loader is properly initialized');
                    bootstrap.push('    if (Ext.Loader) {');
                    bootstrap.push('        Ext.Loader.setConfig({ enabled: false });');
                    bootstrap.push('    }');
                } else {
                    bootstrap.push('    ' + content.replace(/\n/g, '\n    '));
                }
                
                bootstrap.push('    ');
                foundCriticalFiles++;
                console.log('  ✓ Included: ' + path.basename(criticalFile));
            } catch (e) {
                console.warn('  ⚠️  Could not read ' + criticalFile + ': ' + e.message);
            }
        } else {
            console.warn('  ❌ Critical file not found: ' + criticalFile);
        }
    }
    
    // Comprehensive fallback implementations
    bootstrap.push('    // === FALLBACK IMPLEMENTATIONS ===');
    bootstrap.push('    ');
    bootstrap.push('    // Fallback Ext.define if not created by ClassManager');
    bootstrap.push('    if (!Ext.define) {');
    bootstrap.push('        console.warn("ExtJS ClassManager not found - using fallback Ext.define");');
    bootstrap.push('        Ext.define = function(className, config, callback) {');
    bootstrap.push('            console.log("Defining class:", className);');
    bootstrap.push('            ');
    bootstrap.push('            // Simple fallback implementation');
    bootstrap.push('            var nameParts = className.split(".");');
    bootstrap.push('            var root = Ext.global;');
    bootstrap.push('            ');
    bootstrap.push('            for (var i = 0; i < nameParts.length - 1; i++) {');
    bootstrap.push('                if (!root[nameParts[i]]) {');
    bootstrap.push('                    root[nameParts[i]] = {};');
    bootstrap.push('                }');
    bootstrap.push('                root = root[nameParts[i]];');
    bootstrap.push('            }');
    bootstrap.push('            ');
    bootstrap.push('            var finalName = nameParts[nameParts.length - 1];');
    bootstrap.push('            var Constructor = config.extend ? ');
    bootstrap.push('                function() { return config.extend.apply(this, arguments); } : ');
    bootstrap.push('                function() {};');
    bootstrap.push('            ');
    bootstrap.push('            // Set up prototype chain');
    bootstrap.push('            if (config.extend && config.extend.prototype) {');
    bootstrap.push('                Constructor.prototype = Object.create(config.extend.prototype);');
    bootstrap.push('                Constructor.prototype.constructor = Constructor;');
    bootstrap.push('            }');
    bootstrap.push('            ');
    bootstrap.push('            // Copy config properties to prototype');
    bootstrap.push('            for (var key in config) {');
    bootstrap.push('                if (key !== "extend" && config.hasOwnProperty(key)) {');
    bootstrap.push('                    Constructor.prototype[key] = config[key];');
    bootstrap.push('                }');
    bootstrap.push('            }');
    bootstrap.push('            ');
    bootstrap.push('            root[finalName] = Constructor;');
    bootstrap.push('            ');
    bootstrap.push('            if (callback) callback(Constructor);');
    bootstrap.push('            return Constructor;');
    bootstrap.push('        };');
    bootstrap.push('    }');
    bootstrap.push('    ');
    
    // Add other essential Ext functions with more robust implementations
    bootstrap.push('    // === ESSENTIAL EXT UTILITIES ===');
    bootstrap.push('    ');
    bootstrap.push('    Ext.apply = Ext.apply || function(dest, src, defaults) {');
    bootstrap.push('        if (defaults) {');
    bootstrap.push('            Ext.apply(dest, defaults);');
    bootstrap.push('        }');
    bootstrap.push('        if (dest && src && typeof src === "object") {');
    bootstrap.push('            for (var key in src) {');
    bootstrap.push('                if (src.hasOwnProperty(key)) {');
    bootstrap.push('                    dest[key] = src[key];');
    bootstrap.push('                }');
    bootstrap.push('            }');
    bootstrap.push('        }');
    bootstrap.push('        return dest;');
    bootstrap.push('    };');
    bootstrap.push('    ');
    bootstrap.push('    Ext.create = Ext.create || function(className, config) {');
    bootstrap.push('        console.log("Creating:", className);');
    bootstrap.push('        ');
    bootstrap.push('        if (typeof className === "string") {');
    bootstrap.push('            var Class = Ext.ClassManager ? Ext.ClassManager.get(className) : null;');
    bootstrap.push('            if (!Class) {');
    bootstrap.push('                // Try to find the class in the global namespace');
    bootstrap.push('                var parts = className.split(".");');
    bootstrap.push('                Class = global;');
    bootstrap.push('                for (var i = 0; i < parts.length; i++) {');
    bootstrap.push('                    Class = Class[parts[i]];');
    bootstrap.push('                    if (!Class) break;');
    bootstrap.push('                }');
    bootstrap.push('            }');
    bootstrap.push('            ');
    bootstrap.push('            if (Class && typeof Class === "function") {');
    bootstrap.push('                return new Class(config);');
    bootstrap.push('            } else {');
    bootstrap.push('                console.warn("Class not found:", className);');
    bootstrap.push('                return config || {};');
    bootstrap.push('            }');
    bootstrap.push('        }');
    bootstrap.push('        ');
    bootstrap.push('        return config || {};');
    bootstrap.push('    };');
    bootstrap.push('    ');
    bootstrap.push('    Ext.application = Ext.application || function(config) {');
    bootstrap.push('        console.log("Starting application:", config.name || "Unknown");');
    bootstrap.push('        ');
    bootstrap.push('        // Simple application implementation');
    bootstrap.push('        var app = {');
    bootstrap.push('            name: config.name || "App",');
    bootstrap.push('            launch: config.launch || Ext.emptyFn');
    bootstrap.push('        };');
    bootstrap.push('        ');
    bootstrap.push('        // Execute launch function when ready');
    bootstrap.push('        if (typeof app.launch === "function") {');
    bootstrap.push('            Ext.onReady(function() {');
    bootstrap.push('                app.launch.call(app);');
    bootstrap.push('            });');
    bootstrap.push('        }');
    bootstrap.push('        ');
    bootstrap.push('        return app;');
    bootstrap.push('    };');
    bootstrap.push('    ');
    bootstrap.push('    Ext.onReady = Ext.onReady || function(fn, scope) {');
    bootstrap.push('        if (typeof fn !== "function") return;');
    bootstrap.push('        ');
    bootstrap.push('        if (Ext.isReady || document.readyState === "complete") {');
    bootstrap.push('            fn.call(scope || global);');
    bootstrap.push('        } else {');
    bootstrap.push('            Ext.readyListeners.push({ fn: fn, scope: scope });');
    bootstrap.push('            ');
    bootstrap.push('            if (!Ext.readyBound) {');
    bootstrap.push('                Ext.readyBound = true;');
    bootstrap.push('                document.addEventListener("DOMContentLoaded", function() {');
    bootstrap.push('                    Ext.isReady = true;');
    bootstrap.push('                    var listeners = Ext.readyListeners;');
    bootstrap.push('                    for (var i = 0; i < listeners.length; i++) {');
    bootstrap.push('                        listeners[i].fn.call(listeners[i].scope || global);');
    bootstrap.push('                    }');
    bootstrap.push('                    Ext.readyListeners = [];');
    bootstrap.push('                });');
    bootstrap.push('            }');
    bootstrap.push('        }');
    bootstrap.push('    };');
    bootstrap.push('    ');
    
    // Add namespace creation utilities
    bootstrap.push('    // === NAMESPACE UTILITIES ===');
    bootstrap.push('    ');
    bootstrap.push('    Ext.namespace = Ext.ns = function() {');
    bootstrap.push('        var a = arguments, o = null, i, j, d, rt;');
    bootstrap.push('        for (i = 0; i < a.length; ++i) {');
    bootstrap.push('            d = a[i].split(".");');
    bootstrap.push('            rt = d[0];');
    bootstrap.push('            eval("if (typeof " + rt + " == \\"undefined\\"){" + rt + " = {};} o = " + rt + ";");');
    bootstrap.push('            for (j = 1; j < d.length; ++j) {');
    bootstrap.push('                o[d[j]] = o[d[j]] || {};');
    bootstrap.push('                o = o[d[j]];');
    bootstrap.push('            }');
    bootstrap.push('        }');
    bootstrap.push('        return o;');
    bootstrap.push('    };');
    bootstrap.push('    ');
    
    bootstrap.push('    // Initialize basic ExtJS infrastructure');
    bootstrap.push('    console.log("ExtJS minimal bootstrap initialized");');
    bootstrap.push('    console.log("Available functions:", Object.keys(Ext));');
    bootstrap.push('    ');
    bootstrap.push('})(typeof window !== "undefined" ? window : this);');
    
    if (foundCriticalFiles === 0) {
        console.warn('❌ No critical ExtJS files found for bootstrap');
        console.warn('💡 Creating ultra-minimal fallback bootstrap');
        
        // Return an ultra-minimal bootstrap if no files found - NO STRICT MODE
        return `
// Ultra-minimal ExtJS Bootstrap
(function(global) {
    var Ext = global.Ext = global.Ext || {};
    
    // Essential execScript for IE compatibility
    if (!global.execScript) {
        global.execScript = function(code) {
            return global.eval ? global.eval(code) : eval(code);
        };
    }
    Ext.execScript = global.execScript;
    
    // Minimal implementations
    Ext.define = function(name, config) {
        console.log("Defining:", name);
        return config || {};
    };
    
    Ext.create = function(name, config) {
        console.log("Creating:", name);
        return config || {};
    };
    
    Ext.application = function(config) {
        console.log("App:", config.name || "Unknown");
        if (config.launch) config.launch();
        return config;
    };
    
    Ext.onReady = function(fn) {
        if (document.readyState === "complete") fn();
        else document.addEventListener("DOMContentLoaded", fn);
    };
    
    console.log("Ultra-minimal ExtJS bootstrap ready");
})(typeof window !== "undefined" ? window : this);
`;
    }
    
    console.log('✅ Created bootstrap with ' + foundCriticalFiles + '/' + criticalFiles.length + ' critical files');
    return bootstrap.join('\n');
}

async function collectIndividualCoreFiles(extPath) {
    const coreFiles = [];
    
    // Essential ExtJS core files in order
    const essentialCoreFiles = [
        { path: 'packages/core/src/Ext.js', name: 'Ext.js', priority: 1 },
        { path: 'packages/core/src/class/Class.js', name: 'Class.js', priority: 2 },
        { path: 'packages/core/src/class/Base.js', name: 'Base.js', priority: 3 },
        { path: 'packages/core/src/class/ClassManager.js', name: 'ClassManager.js', priority: 4 },
        { path: 'packages/core/src/Loader.js', name: 'Loader.js', priority: 5 },
    ];
    
    for (const coreFileInfo of essentialCoreFiles) {
        const coreFilePath = path.join(extPath, coreFileInfo.path);
        if (await fs.pathExists(coreFilePath)) {
            const resolvedPath = path.resolve(coreFilePath);
            console.log(`✅ Found core file: ${coreFileInfo.name}`);
            
            try {
                const content = await fs.readFile(coreFilePath, 'utf-8');
                fileContentCache.set(resolvedPath, content);
                
                const coreClassName = `__CORE_${coreFileInfo.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
                coreFiles.push({
                    className: coreClassName,
                    filePath: resolvedPath,
                    isExtJS: true,
                    isCore: true,
                    priority: coreFileInfo.priority,
                    dependencies: [],
                    content: content
                });
                
            } catch (e) {
                console.warn(`⚠️  Could not read core file ${coreFilePath}: ${e.message}`);
            }
        }
    }
    
    if (coreFiles.length === 0) {
        console.warn('❌ No ExtJS core files found! The build will not work properly.');
        console.warn('💡 Please ensure you have a proper ExtJS SDK with either:');
        console.warn('   • Pre-built bundles (build/ext-all-debug.js)');
        console.warn('   • Core source files (packages/core/src/)');
    }
    
    return coreFiles.sort((a, b) => a.priority - b.priority);
}

async function expandWildcardDependencies(dependencies, fileIndex, namespace) {
    const expanded = [];
    const wildcards = [];
    
    console.log(`🔍 Expanding dependencies: ${dependencies.join(', ')}`);
    
    for (const dep of dependencies) {
        if (dep.endsWith('.*')) {
            wildcards.push(dep);
            const prefix = dep.slice(0, -2); // Remove '.*'
            
            console.log(`   🔍 Expanding wildcard: ${dep} (prefix: ${prefix})`);
            
            // Find all classes that match this prefix
            let matchCount = 0;
            for (const [className, fileInfo] of fileIndex) {
                if (className.startsWith(prefix + '.')) {
                    expanded.push(className);
                    matchCount++;
                    if (matchCount <= 5) { // Show first 5 matches
                        console.log(`     ✓ Found: ${className}`);
                    }
                }
            }
            
            if (matchCount > 5) {
                console.log(`     ... and ${matchCount - 5} more classes`);
            } else if (matchCount === 0) {
                console.log(`     ❌ No classes found for wildcard: ${dep}`);
            }
            
        } else {
            expanded.push(dep);
            console.log(`   ✓ Direct dependency: ${dep}`);
        }
    }
    
    if (wildcards.length > 0) {
        const newClasses = expanded.filter(dep => !dependencies.includes(dep));
        console.log(`🎯 Wildcard expansion: ${wildcards.join(', ')} -> ${newClasses.length} new classes`);
    }
    
    return [...new Set(expanded)]; // Remove duplicates
}

async function buildDependencyGraphFromEntry(entryClassName, fileIndex) {
    console.log(`🔗 Building dependency graph starting from: ${entryClassName}`);
    
    const requiredClasses = new Set();
    const requiredFiles = [];
    const visited = new Set();
    const processing = new Set(); // Track what we're currently processing to detect cycles
    const classToFileMap = new Map(); // Track which file provides each class
    const queue = [entryClassName];
    
    while (queue.length > 0) {
        const currentClass = queue.shift();
        
        if (visited.has(currentClass)) {
            continue;
        }
        
        if (processing.has(currentClass)) {
            console.warn(`⚠️  Circular dependency detected for class: ${currentClass}`);
            continue;
        }
        
        processing.add(currentClass);
        visited.add(currentClass);
        
        // Find the file for this class
        const fileInfo = fileIndex.get(currentClass);
        if (!fileInfo) {
            console.warn(`⚠️  Could not find file for class: ${currentClass}`);
            
            // Debug: If it's an ExtJS class, let's see what similar classes we do have
            if (currentClass.startsWith('Ext.')) {
                const similarClasses = Array.from(fileIndex.keys())
                    .filter(name => name.startsWith('Ext.'))
                    .filter(name => name.includes(currentClass.split('.')[1] || ''))
                    .slice(0, 5);
                if (similarClasses.length > 0) {
                    console.log(`   💡 Similar ExtJS classes found: ${similarClasses.join(', ')}`);
                }
                
                // Check if this exact class exists with different case
                const exactMatch = Array.from(fileIndex.keys())
                    .find(name => name.toLowerCase() === currentClass.toLowerCase());
                if (exactMatch) {
                    console.log(`   💡 Found case mismatch: ${exactMatch} vs ${currentClass}`);
                }
            }
            
            processing.delete(currentClass);
            continue;
        }
        
        // Check for duplicate class definitions
        if (classToFileMap.has(currentClass)) {
            const existingFile = classToFileMap.get(currentClass);
            if (existingFile !== fileInfo.path) {
                console.warn(`⚠️  Duplicate class definition found:`);
                console.warn(`   Class: ${currentClass}`);
                console.warn(`   File 1: ${existingFile}`);
                console.warn(`   File 2: ${fileInfo.path}`);
                console.warn(`   Using first definition to avoid duplicates`);
                processing.delete(currentClass);
                continue;
            }
        }
        
        requiredClasses.add(currentClass);
        classToFileMap.set(currentClass, fileInfo.path);
        
        try {
            // Parse the file using AST to get its dependencies
            const content = await fs.readFile(fileInfo.path, 'utf-8');
            fileContentCache.set(fileInfo.path, content);
            
            const parsedFile = await parseJsFile(fileInfo.path);
            
            if (parsedFile.classes.length > 0) {
                // Find the specific class we're looking for in this file
                let classInfo = parsedFile.classes.find(cls => cls.name === currentClass);
                if (!classInfo && parsedFile.classes.length === 1) {
                    // If only one class in file, assume it's the one we want
                    classInfo = parsedFile.classes[0];
                }
                
                if (classInfo) {
                    // Get dependencies from AST analysis
                    let dependencies = classInfo.dependencies || [];
                    
                    // Expand wildcard dependencies
                    dependencies = await expandWildcardDependencies(dependencies, fileIndex);
                    
                    // Filter out dependencies we've already processed to avoid cycles
                    const newDependencies = dependencies.filter(dep => 
                        !visited.has(dep) && !processing.has(dep)
                    );
                    
                    // Check if this file is already included (avoid duplicate files)
                    const existingFile = requiredFiles.find(f => f.filePath === fileInfo.path);
                    if (existingFile) {
                        console.log(`  ⚠️  File already included: ${path.basename(fileInfo.path)} (skipping duplicate)`);
                    } else {
                        requiredFiles.push({
                            className: currentClass,
                            filePath: fileInfo.path,
                            isExtJS: fileInfo.isExtJS,
                            dependencies: dependencies,
                            content: content
                        });
                        
                        console.log(`  ✓ ${currentClass} (${fileInfo.isExtJS ? 'ExtJS' : 'App'}) -> ${newDependencies.length} new deps${newDependencies.length > 0 ? ': ' + newDependencies.join(', ') : ''}`);
                    }
                    
                    // Add new dependencies to queue
                    for (const dep of newDependencies) {
                        if (!queue.includes(dep)) {
                            queue.push(dep);
                        }
                    }
                } else {
                    console.warn(`⚠️  Target class ${currentClass} not found in ${fileInfo.path}`);
                }
            } else {
                console.warn(`⚠️  No classes found in ${fileInfo.path}`);
            }
            
        } catch (e) {
            console.warn(`⚠️  Error processing ${fileInfo.path}: ${e.message}`);
        }
        
        processing.delete(currentClass);
    }
    
    // Deduplicate required files by class name and file path
    const deduplicatedFiles = [];
    const seenClasses = new Set();
    const seenFiles = new Set();
    
    for (const file of requiredFiles) {
        const key = `${file.className}:${file.filePath}`;
        if (!seenClasses.has(file.className) && !seenFiles.has(file.filePath)) {
            deduplicatedFiles.push(file);
            seenClasses.add(file.className);
            seenFiles.add(file.filePath);
        } else {
            console.log(`  🔄 Skipping duplicate: ${file.className} (${path.basename(file.filePath)})`);
        }
    }
    
    if (requiredClasses.size === 0) {
        console.log(`❌ No classes were found in the dependency chain!`);
        console.log(`💡 This might happen if:`);
        console.log(`   • Your Application.js is empty or malformed`);
        console.log(`   • The entry class doesn't extend anything`);
        console.log(`   • There are no 'requires' or 'uses' arrays`);
        console.log(`💡 Try adding some basic requirements to your Application.js`);
        
        // Even if empty, we should still include the entry file itself
        if (deduplicatedFiles.length === 0) {
            const entryFileInfo = fileIndex.get(entryClassName);
            if (entryFileInfo) {
                const content = await fs.readFile(entryFileInfo.path, 'utf-8');
                deduplicatedFiles.push({
                    className: entryClassName,
                    filePath: entryFileInfo.path,
                    isExtJS: entryFileInfo.isExtJS,
                    dependencies: [],
                    content: content
                });
                requiredClasses.add(entryClassName);
                console.log(`📝 Added entry file itself: ${entryClassName}`);
            }
        }
    }
    
    const originalCount = requiredFiles.length;
    const finalCount = deduplicatedFiles.length;
    const duplicatesRemoved = originalCount - finalCount;
    
    console.log(`📊 Found ${requiredClasses.size} required classes (started from ${entryClassName})`);
    if (duplicatesRemoved > 0) {
        console.log(`🔄 Removed ${duplicatesRemoved} duplicate files/classes`);
    }
    
    return {
        requiredClasses: Array.from(requiredClasses),
        requiredFiles: deduplicatedFiles
    };
}

// --- Topological Sort for Required Files ---

function topologicalSortRequired(requiredFiles) {
    console.log('🔄 Performing topological sort on required files...');
    
    // Separate core files from regular files
    const coreFiles = requiredFiles.filter(file => file.isCore);
    const regularFiles = requiredFiles.filter(file => !file.isCore);
    
    const classToFile = new Map();
    const graph = new Map();
    
    // Build maps for regular files only
    for (const file of regularFiles) {
        classToFile.set(file.className, file);
        graph.set(file.className, new Set());
    }
    
    // Build dependency edges (only for classes we actually have)
    for (const file of regularFiles) {
        for (const dep of file.dependencies) {
            if (classToFile.has(dep)) {
                graph.get(file.className).add(dep);
            }
        }
    }
    
    const visited = new Set();
    const visiting = new Set();
    const sortedRegular = [];
    
    function visit(className) {
        if (visiting.has(className)) {
            console.warn(`⚠️  Circular dependency detected involving: ${className}`);
            return;
        }
        
        if (visited.has(className)) {
            return;
        }
        
        visiting.add(className);
        
        const dependencies = graph.get(className) || new Set();
        for (const dep of dependencies) {
            visit(dep);
        }
        
        visiting.delete(className);
        visited.add(className);
        
        if (classToFile.has(className)) {
            sortedRegular.push(classToFile.get(className));
        }
    }
    
    // Visit all regular classes
    for (const className of graph.keys()) {
        visit(className);
    }
    
    // Combine: core files first (in priority order), then sorted regular files
    const sortedCoreFiles = coreFiles.sort((a, b) => a.priority - b.priority);
    const result = [...sortedCoreFiles, ...sortedRegular];
    
    console.log(`✅ Sorted ${result.length} files: ${coreFiles.length} core + ${sortedRegular.length} regular`);
    return result;
}

// --- JavaScript Processing ---

async function concatenateRequiredFiles(sortedFiles) {
    console.log('📦 Concatenating required JavaScript files...');
    
    const concatenated = [];
    
    // Add banner
    concatenated.push(`/**
 * ExtJS Application Bundle
 * Generated: ${new Date().toISOString()}
 * Files: ${sortedFiles.length}
 * Built with AST-based dependency analysis
 */`);
    
    // Start with immediate function - NO strict mode for ExtJS compatibility
    concatenated.push('\n(function(global) {\n');
    
    // Set up global context for ExtJS and duplicate class detection
    concatenated.push('    // === GLOBAL CONTEXT SETUP ===\n');
    concatenated.push('    // ExtJS expects \'this\' to be the global object\n');
    concatenated.push('    var originalThis = this;\n');
    concatenated.push('    \n');
    concatenated.push('    // Track defined classes to prevent duplicates\n');
    concatenated.push('    var __customBuildDefinedClasses = {}; // Use a unique name\n');
    concatenated.push('    var originalExtDefine = null;\n');
    concatenated.push('    var __customBuildDefineWrapped = false;\n');
    concatenated.push('    \n');    concatenated.push('    // Ensure execScript is available globally\n');
    concatenated.push('    if (!global.execScript) {\n');
    concatenated.push('        global.execScript = function(code) {\n');
    concatenated.push('            return global.eval ? global.eval(code) : eval(code);\n');
    concatenated.push('        };\n');
    concatenated.push('    }\n');
    concatenated.push('    \n');
    concatenated.push('    // Patch any ExtJS code that relies on \'this\' being global\n');
    concatenated.push('    function patchExtJSContext(code) {\n');
    concatenated.push('        // Replace this.execScript with global.execScript\n');
    concatenated.push('        return code.replace(/\\bthis\\.execScript\\b/g, \'global.execScript\')\n');
    concatenated.push('                   .replace(/\\bthis\\.eval\\b/g, \'global.eval\')\n');
    concatenated.push('                   .replace(/\\bthis\\.setTimeout\\b/g, \'global.setTimeout\')\n');
    concatenated.push('                   .replace(/\\bthis\\.setInterval\\b/g, \'global.setInterval\');\n');
    concatenated.push('    }\n');
    concatenated.push('    \n');
    concatenated.push('    // Wrap Ext.define to detect and prevent duplicates\n');
    concatenated.push('    function internalAttemptWrapExtDefine() {\n');
    concatenated.push('        if (__customBuildDefineWrapped) return;\n');
    concatenated.push('        if (typeof Ext !== "undefined" && typeof Ext.define === "function") {\n');
    concatenated.push('            if (Ext.define.isWrappedByCustomBuild) { __customBuildDefineWrapped = true; return; }\n'); // Avoid double wrapping
    concatenated.push('            originalExtDefine = Ext.define;\n');
    concatenated.push('            Ext.define = function(className, config, callback) {\n');
    concatenated.push('                if (__customBuildDefinedClasses[className]) {\n');
    concatenated.push('                    console.warn("⚠️  Duplicate class definition prevented by wrapper:", className);\n');
    concatenated.push('                    console.warn("   Previously defined at:", __customBuildDefinedClasses[className]);\n');
    concatenated.push('                    if (callback) { callback.call(this); } // Call callback as Ext.define would\n');
    concatenated.push('                    return Ext.ClassManager.get(className); // Return existing class\n');
    concatenated.push('                }\n');
    concatenated.push('                \n');
    concatenated.push('                // Track where this class was defined\n');
    concatenated.push('                var stack = new Error().stack;\n');
    concatenated.push('                var location = stack ? stack.split("\\n")[2] : "unknown";\n');
    concatenated.push('                __customBuildDefinedClasses[className] = location;\n');
    concatenated.push('                \n');
    concatenated.push('                // Call original Ext.define\n');
    concatenated.push('                return originalExtDefine.call(this, className, config, callback);\n');
    concatenated.push('            };\n');
    concatenated.push('            Ext.define.isWrappedByCustomBuild = true; // Mark as wrapped\n');
    concatenated.push('            // Copy any properties from original function\n');
    concatenated.push('            for (var prop in originalExtDefine) {\n');
    concatenated.push('                if (originalExtDefine.hasOwnProperty(prop)) {\n');
    concatenated.push('                    Ext.define[prop] = originalExtDefine[prop];\n');
    concatenated.push('                }\n');
    concatenated.push('            }\n');
    concatenated.push('            console.log("✅ Ext.define wrapped for duplicate class detection.");\n');
    concatenated.push('            __customBuildDefineWrapped = true;\n');
    concatenated.push('        }\n');
    concatenated.push('    }\n');
    concatenated.push('    \n');
    
    // Add each required file
    for (const file of sortedFiles) {
        let content = fileContentCache.get(file.filePath) || file.content || '';
        
        if (file.isCore) {
            // Core files - handle ExtJS bootstrap specially
            if (file.className.includes('BOOTSTRAP') || file.className.includes('BUNDLE')) {
                concatenated.push(`\n    // === ExtJS Core Bootstrap ===\n`);
                // Don't double-wrap if it's already wrapped
                if (content.includes('(function(global)')) {
                    concatenated.push(content);
                } else {
                    // Patch the content for proper global context
                    content = content.replace(/\bthis\.execScript\b/g, 'global.execScript')
                                   .replace(/\bthis\.eval\b/g, 'global.eval')
                                   .replace(/\bthis\.setTimeout\b/g, 'global.setTimeout')
                                   .replace(/\bthis\.setInterval\b/g, 'global.setInterval');
                    
                    concatenated.push('    ' + content.replace(/\n/g, '\n    '));
                }
                concatenated.push('\n');
                
                // Attempt to wrap Ext.define after core bundle/bootstrap is loaded
                concatenated.push('    internalAttemptWrapExtDefine();\n');
                concatenated.push('\n');
            } else {
                concatenated.push(`\n    // === ExtJS Core File: ${path.basename(file.filePath)} ===\n`);
                
                // Patch ExtJS core files for proper context
                content = content.replace(/\bthis\.execScript\b/g, 'global.execScript')
                               .replace(/\bthis\.eval\b/g, 'global.eval')
                               .replace(/\bthis\.setTimeout\b/g, 'global.setTimeout')
                               .replace(/\bthis\.setInterval\b/g, 'global.setInterval');
                
                // Wrap in function call to ensure proper 'this' context
                concatenated.push('    (function() {\n');
                concatenated.push('        var self = this;\n');
                concatenated.push('        ' + content.replace(/\n/g, '\n        ') + '\n');
                concatenated.push('    }).call(global);\n');
                // Attempt to wrap Ext.define after core files like ClassManager
                concatenated.push('    internalAttemptWrapExtDefine();\n');
                concatenated.push('\n');
            }
        } else {
            // Regular class files
            concatenated.push(`\n    // Class: ${file.className}\n    // File: ${file.filePath}\n`);
            
            // Patch application files too
            content = content.replace(/\bthis\.execScript\b/g, 'global.execScript')
                           .replace(/\bthis\.eval\b/g, 'global.eval');
            
            concatenated.push('    ' + content.replace(/\n/g, '\n    '));
            concatenated.push('\n');
        }
    }
    
    // Add comprehensive initialization verification
    concatenated.push(`
    // === EXTJS VERIFICATION & INITIALIZATION ===
    
    // Verify ExtJS is properly initialized
    function verifyExtJSSetup() {
        var errors = [];
        var warnings = [];
        
        if (typeof Ext === 'undefined') {
            errors.push('Ext object not found - ExtJS not loaded');
            return { success: false, errors: errors, warnings: warnings };
        }
        
        // Check critical functions
        if (typeof Ext.define !== 'function') {
            errors.push('Ext.define not found - class system not initialized');
        }
        
        if (typeof Ext.create !== 'function') {
            warnings.push('Ext.create not found - object creation may not work');
        }
        
        if (typeof Ext.application !== 'function') {
            warnings.push('Ext.application not found - application bootstrap may not work');
        }
        
        if (typeof Ext.onReady !== 'function') {
            warnings.push('Ext.onReady not found - DOM ready handling may not work');
        }
        
        // Check for execScript which caused the original error
        if (typeof Ext.execScript !== 'function' && typeof global.execScript !== 'function') {
            warnings.push('execScript not found - dynamic script execution may fail');
        }
        
        // Check globalEval specifically
        if (typeof Ext.globalEval !== 'function') {
            console.log('Creating fallback Ext.globalEval...');
            Ext.globalEval = function(code) {
                if (global.execScript) {
                    return global.execScript(code);
                } else if (global.eval) {
                    return global.eval(code);
                } else {
                    return eval(code);
                }
            };
        }
        
        // Enable duplicate detection if not already done
        internalAttemptWrapExtDefine();
        
        // Check loader system
        if (Ext.Loader && typeof Ext.Loader.setConfig === 'function') {
            // Disable loader since we're using a bundled approach
            Ext.Loader.setConfig({ enabled: false });
        }
        
        return {
            success: errors.length === 0,
            errors: errors,
            warnings: warnings
        };
    }
    
    // Run verification
    var verification = verifyExtJSSetup();
    
    if (!verification.success) {
        console.error('❌ ExtJS Bundle Verification Failed:');
        verification.errors.forEach(function(error) {
            console.error('  • ' + error);
        });
        
        // Try to provide helpful guidance
        console.error('');
        console.error('💡 Possible solutions:');
        console.error('  • Ensure your ExtJS SDK is complete and properly extracted');
        console.error('  • Check that --ext-path points to a valid ExtJS installation');
        console.error('  • Verify build/ext-all-debug.js exists in your ExtJS SDK');
        console.error('  • Try using a pre-built ExtJS bundle instead of individual files');
        
        throw new Error('ExtJS bundle is incomplete - cannot start application');
    }
    
    if (verification.warnings.length > 0) {
        console.warn('⚠️  ExtJS Bundle Warnings:');
        verification.warnings.forEach(function(warning) {
            console.warn('  • ' + warning);
        });
    }
    
    console.log('✅ ExtJS Application Bundle loaded successfully');
    console.log('📋 Available Ext functions:', Object.keys(Ext).slice(0, 10).join(', '));
    console.log('🔧 execScript available:', typeof (Ext.execScript || global.execScript) === 'function');
    console.log('🔧 globalEval available:', typeof Ext.globalEval === 'function');
    console.log('🌐 Global context properly set:', typeof global === 'object');
    console.log('🛡️  Duplicate class protection active:', __customBuildDefineWrapped);
    console.log('📊 Total classes monitored by wrapper:', Object.keys(__customBuildDefinedClasses).length);
    
})(typeof window !== "undefined" ? window : this);
`);
    
    return concatenated.join('');
}

async function minifyJs(code, buildProfile) {
    // The decision to call this function is handled by config.minifyJs in buildExtApp
    // This function minifies if called, using buildProfile for specific options.
    if (!code) { // Handle empty code case
        return code;
    }
    console.log('🗜️  Minifying JavaScript...');
    try {
        // Terser options for minification
        const terserOptions = {
            compress: {
                drop_debugger: true,
                unused: true,       // Ensure unused variables/functions are removed (default: true)
                dead_code: true,    // Ensure dead code is removed (default: true)
                // Add more passes for potentially better optimization; can increase build time.
                // This is a key change for further size reduction.
                passes: 2,
                hoist_funs: true,   // Hoist function declarations, can improve optimization opportunities.
                keep_fargs: false,  // Remove unused function arguments. `unused: true` often covers this,
                                    // but being explicit can be beneficial.
            },
            mangle: {
                reserved: ['Ext'] // Don't mangle ExtJS namespace
            },
            output: {
                comments: false // Remove all comments
            }
        };

        // Apply options that might depend on the build profile for more targeted optimization
        if (buildProfile === 'production') {
            terserOptions.compress.drop_console = true;
            terserOptions.compress.pure_funcs = ['console.log', 'console.info', 'console.debug', 'Ext.emptyFn'];
            // `toplevel: true` can further reduce size by dropping unreferenced top-level
            // functions and variables. However, this is more aggressive and requires
            // thorough testing to ensure no dynamically accessed global code is removed.
            // E.g., terserOptions.compress.toplevel = true;

            terserOptions.output.ecma = 2015; // Output ES2015 syntax if smaller and target browsers support it.
        } else {
            // For non-production builds, you might want to keep console logs
            terserOptions.compress.drop_console = false;
            // Still mark Ext.emptyFn as pure if minifying non-production code
            terserOptions.compress.pure_funcs = ['Ext.emptyFn'];
            // Non-production builds might stick to ES5 for broader compatibility during development.
            terserOptions.output.ecma = 5; // Or leave undefined to use Terser's default (ES5).
        }

        const result = await Terser.minify(code, terserOptions);
        
        console.log(`📉 Reduced JavaScript size by ${((1 - result.code.length / code.length) * 100).toFixed(1)}%`);
        return result.code;
    } catch (e) {
        console.warn(`⚠️  JavaScript minification failed: ${e.message}`);
        return code;
    }
}

// --- SASS/CSS Processing ---

async function findSassEntryPoint(theme, sassPaths) {
    const possibleEntryPoints = [
        ...sassPaths.map(p => path.join(p, 'app.scss')),
        ...sassPaths.map(p => path.join(p, 'all.scss')),
        './sass/app.scss',
        './resources/sass/app.scss'
    ];
    
    for (const entryPoint of possibleEntryPoints) {
        if (await fs.pathExists(entryPoint)) {
            console.log(`🎨 Found SASS entry point: ${entryPoint}`);
            return entryPoint;
        }
    }
    
    console.warn('⚠️  No SASS entry point found, skipping CSS compilation');
    return null;
}

async function compileSass(entryPoint, buildProfile, extPath) {
    if (!entryPoint) return '';
    
    console.log('🎨 Compiling SASS...');
    
    try {
        const includePaths = [
            path.dirname(entryPoint),
            path.join(extPath, 'packages'),
            path.join(extPath, 'classic', 'theme-triton', 'sass'),
            path.join(extPath, 'classic', 'theme-neptune', 'sass'),
            path.join(extPath, 'classic', 'theme-classic', 'sass')
        ];
        
        const result = sass.compile(entryPoint, {
            includePaths: includePaths,
            outputStyle: buildProfile === 'production' ? 'compressed' : 'expanded',
            sourceMap: buildProfile !== 'production'
        });
        
        console.log('✅ SASS compilation completed');
        return result.css;
    } catch (e) {
        console.error(`❌ SASS compilation failed: ${e.message}`);
        return '';
    }
}

async function minifyCss(css, buildProfile) {
    if (buildProfile !== 'production' || !css) {
        return css;
    }
    
    console.log('🗜️  Minifying CSS...');
    
    try {
        const cleanCSS = new CleanCSS({
            level: 2,
            returnPromise: false
        });
        
        const result = cleanCSS.minify(css);
        
        if (result.errors.length > 0) {
            console.warn('⚠️  CSS minification warnings:', result.errors);
        }
        
        console.log(`📉 Reduced CSS size by ${((1 - result.styles.length / css.length) * 100).toFixed(1)}%`);
        return result.styles;
    } catch (e) {
        console.warn(`⚠️  CSS minification failed: ${e.message}`);
        return css;
    }
}

// --- Resource Processing ---

async function copyAndOptimizeResources(resourceConfigs, buildDir) {
    console.log('📁 Processing resources...');
    
    for (const config of resourceConfigs) {
        const sourcePath = config.path;
        const outputPath = path.join(buildDir, config.output || 'resources');
        
        if (await fs.pathExists(sourcePath)) {
            await fs.ensureDir(outputPath);
            await fs.copy(sourcePath, outputPath);
            console.log(`📂 Copied resources from ${sourcePath} to ${outputPath}`);
        }
    }
}

// --- Manifest Generation ---

function generateBuildManifest(jsContent, cssContent, buildId) {
    return {
        id: buildId,
        created: new Date().toISOString(),
        js: [
            {
                path: `${buildId}/app.js`,
                version: generateHash(jsContent),
                size: jsContent.length
            }
        ],
        css: [
            {
                path: `${buildId}/app.css`,
                version: generateHash(cssContent),
                size: cssContent.length
            }
        ]
    };
}

function generateBootstrapJs(manifest) {
    const cssStatements = manifest.css.map(css => 
        `Ext.util.CSS.createStyleSheet('${css.path}?v=${css.version}');`
    ).join('\n        ');
    
    return `/**
 * ExtJS Application Bootstrap
 * Generated: ${new Date().toISOString()}
 */

// Diagnostic function to check ExtJS setup
function checkExtJSSetup() {
    var issues = [];
    
    if (typeof Ext === 'undefined') {
        issues.push('Ext object not found - ExtJS not loaded');
    } else {
        if (typeof Ext.define !== 'function') {
            issues.push('Ext.define is not a function - class system not initialized');
        }
        if (typeof Ext.create !== 'function') {
            issues.push('Ext.create is not a function - instantiation system not available');
        }
        if (typeof Ext.onReady !== 'function') {
            issues.push('Ext.onReady is not a function - DOM ready system not available');
        }
    }
    
    if (issues.length > 0) {
        console.error('ExtJS Setup Issues:');
        issues.forEach(function(issue) {
            console.error('  ❌ ' + issue);
        });
        return false;
    } else {
        console.log('✅ ExtJS setup verification passed');
        return true;
    }
}

// Check ExtJS setup before proceeding
if (!checkExtJSSetup()) {
    console.error('Cannot start application - ExtJS not properly initialized');
    console.error('💡 Check that your ExtJS bundle is complete and loaded correctly');
} else {
    Ext.onReady(function() {
        // Load application CSS
        ${cssStatements}
        
        // Application is ready
        console.log('ExtJS Application loaded successfully');
        console.log('Build ID: ${manifest.id}');
        console.log('Generated: ${manifest.created}');
        console.log('Available functions:', {
            'Ext.define': typeof Ext.define,
            'Ext.create': typeof Ext.create,
            'Ext.application': typeof Ext.application
        });
    });
}`;
}

// --- Index.html Processing ---

async function updateIndexHtml(indexPath, buildDir, manifest) {
    const indexOutputPath = path.join(buildDir, 'index.html');
    
    try {
        let htmlContent = '';
        
        if (await fs.pathExists(indexPath)) {
            htmlContent = await fs.readFile(indexPath, 'utf-8');
        } else {
            // Generate basic HTML template
            htmlContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>ExtJS Application</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
    <div id="loading">Loading...</div>
</body>
</html>`;
        }
        
        // Inject CSS and JS references
        const cssLinks = manifest.css.map(css => 
            `    <link rel="stylesheet" href="${css.path}?v=${css.version}">`
        ).join('\n');
        
        const jsScripts = manifest.js.map(js => 
            `    <script src="${js.path}?v=${js.version}"></script>`
        ).join('\n');
        
        // Insert before closing head tag
        htmlContent = htmlContent.replace(
            '</head>',
            `${cssLinks}\n${jsScripts}\n</head>`
        );
        
        await fs.writeFile(indexOutputPath, htmlContent);
        console.log(`📄 Updated index.html at ${indexOutputPath}`);
    } catch (e) {
        console.warn(`⚠️  Could not update index.html: ${e.message}`);
    }
}

// --- Main Build Function ---

async function buildExtApp(options = {}) {
    const config = { ...DEFAULT_CONFIG, ...options };
    const startTime = Date.now();
    
    console.log(`🚀 Starting ExtJS build with AST-based dependency analysis...`);
    console.log(`📋 Configuration:`, config);
    
    try {
        // 1. Load configurations
        const appConfig = await loadAppJson(config.appJsonPath);
        const workspaceConfig = await loadWorkspaceJson(config.workspaceJsonPath);
        
        // 2. Ensure build directory exists
        await fs.ensureDir(config.buildDir);
        
        // 3. Build file index using AST parsing
        const jsPaths = appConfig.classpath || ['app'];
        const fileIndex = await buildFileIndex(jsPaths, config.extPath);
        
        // 4. Find application entry point
        const entryFilePath = await findApplicationEntryPoint(jsPaths);
        const entryClassName = await getEntryClassName(entryFilePath);
        console.log(`🎯 Starting dependency analysis from: ${entryClassName}`);
        
        // 5. Add ExtJS core files first
        const coreFiles = await addExtJSCoreFiles(fileIndex, config.extPath, config); // Pass config
        
        // 6. Build dependency graph starting from entry point using AST analysis
        let { requiredClasses, requiredFiles: appAndExtDependencies } = await buildDependencyGraphFromEntry(entryClassName, fileIndex);
        
        // 7. Combine core files with resolved dependencies.
        // If a core bundle is used, filter out individual ExtJS files from dependencies
        // to prevent including framework code twice.
        let allRequiredFilesInput;
        const hasCoreBundle = coreFiles.some(f =>
            (f.className && f.className.includes('__CORE_BUNDLE_')) || // Bundles identified by addExtJSCoreFiles
            (f.filePath && (f.filePath.includes('ext-all') || (f.filePath.includes('ext.js') && !f.filePath.includes('Ext.js')))) // Heuristic for common bundle names
        );

        if (hasCoreBundle && !coreFiles.some(f => f.className === '__CORE_MINIMAL_BOOTSTRAP')) { // Don't filter if the "bundle" is just our minimal bootstrap
            console.log('ℹ️  Core ExtJS bundle detected. Filtering individual ExtJS framework files from dependencies.');
            const appFilesOnly = appAndExtDependencies.filter(f => !f.isExtJS);
            allRequiredFilesInput = [...coreFiles, ...appFilesOnly];
            
            // Adjust requiredClasses count if we filtered out ExtJS files that were individually resolved
            const appFilePaths = new Set(appFilesOnly.map(f => f.filePath));
            const coreFilePaths = new Set(coreFiles.map(f => f.filePath));
            requiredClasses = requiredClasses.filter(className => {
                const fileInfo = fileIndex.get(className);
                return !fileInfo || !fileInfo.isExtJS || appFilePaths.has(fileInfo.path) || coreFilePaths.has(fileInfo.path);
            });
        } else {
            allRequiredFilesInput = [...coreFiles, ...appAndExtDependencies];
        }

        // Deduplicate the combined list by filePath to ensure each file is processed once for sorting.
        const finalUniqueFiles = [];
        const seenFilePaths = new Set();
        for (const file of allRequiredFilesInput) {
            if (!seenFilePaths.has(file.filePath)) {
                finalUniqueFiles.push(file);
                seenFilePaths.add(file.filePath);
            } else {
                console.log(`  ℹ️  Deduplicating file path during final assembly: ${file.filePath} (class: ${file.className}).`);
            }
        }
        
        // 8. Sort required files by dependencies
        const sortedFiles = topologicalSortRequired(finalUniqueFiles);
        
        // 9. Process JavaScript (only required files)
        let concatenatedJs = ''; // Initialize
        let finalJs = '';        // Initialize
        let unminifiedJsSize = 0;  // Initialize

        if (sortedFiles.length > 0) {
            concatenatedJs = await concatenateRequiredFiles(sortedFiles); // Assign concatenatedJs
            unminifiedJsSize = Buffer.byteLength(concatenatedJs, 'utf8');

            if (config.minifyJs) { // Use minifyJs flag from config
                console.log('🚀 Minification enabled via config.minifyJs.');
                // Call the minifyJs function (defined around line 1425) that accepts buildProfile
                finalJs = await minifyJs(concatenatedJs, config.buildProfile);
            } else {
                finalJs = concatenatedJs;
            }
            // The line below seems redundant as jsOutputDir is not defined here,
            // and the final JS is written to jsOutputPath later.
            // await fs.writeFile(path.join(jsOutputDir, 'app.js'), finalJs); 
        } else {
            console.log(`⚠️  No files to concatenate - creating minimal bundle`);
            finalJs = `/**
 * ExtJS Application Bundle - Minimal
 * Generated: ${new Date().toISOString()}
 * Entry: ${entryClassName}
 * Built with AST-based dependency analysis
 */

// No dependencies found - this might indicate an empty application
console.log('ExtJS Application loaded (minimal build)');
`;
            unminifiedJsSize = Buffer.byteLength(finalJs, 'utf8'); // Set size for minimal bundle
        }
        
        // 10. Process CSS
        const sassPaths = appConfig.sass ? [appConfig.sass.src, appConfig.sass.var, appConfig.sass.etc].flat() : [];
        const sassEntryPoint = await findSassEntryPoint(appConfig.theme, sassPaths);
        const compiledCss = await compileSass(sassEntryPoint, config.buildProfile, config.extPath);
        const finalCss = config.minifyCss ? await minifyCss(compiledCss, config.buildProfile) : compiledCss;
        
        // 11. Generate build ID and paths
        const buildId = generateHash(finalJs + finalCss);
        const jsOutputPath = path.join(config.buildDir, buildId, 'app.js');
        const cssOutputPath = path.join(config.buildDir, buildId, 'app.css');
        
        // 12. Write output files
        await fs.ensureDir(path.dirname(jsOutputPath));
        await fs.writeFile(jsOutputPath, finalJs);
        console.log(`📦 JavaScript written to: ${jsOutputPath}`);
        
        if (finalCss) {
            await fs.writeFile(cssOutputPath, finalCss);
            console.log(`🎨 CSS written to: ${cssOutputPath}`);
        }
        
        // 13. Process resources
        if (appConfig.resources) {
            await copyAndOptimizeResources(appConfig.resources, config.buildDir);
        }
        
        // 14. Generate manifest
        const manifest = generateBuildManifest(finalJs, finalCss, buildId);
        const manifestPath = path.join(config.buildDir, `${buildId}.json`);
        await fs.writeJson(manifestPath, manifest, { spaces: 2 });
        console.log(`📋 Manifest written to: ${manifestPath}`);
        
        // 15. Generate bootstrap
        const bootstrapContent = generateBootstrapJs(manifest);
        const bootstrapPath = path.join(config.buildDir, 'bootstrap.js');
        await fs.writeFile(bootstrapPath, bootstrapContent);
        console.log(`🔧 Bootstrap written to: ${bootstrapPath}`);
        
        // 16. Update index.html
        await updateIndexHtml(config.indexPath, config.buildDir, manifest);
        
        // 17. Build summary
        const buildTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const extjsClassesInOutput = sortedFiles.filter(f => f.isExtJS && !f.isCore).length;
        const appClassesInOutput = sortedFiles.filter(f => !f.isExtJS).length;
        const coreFilesInOutput = sortedFiles.filter(f => f.isCore).length;
        
        console.log(`\n✅ Build completed successfully in ${buildTime}s using AST parsing!`);
        console.log(`📊 Summary:`);
        console.log(`   • Entry Point: ${entryClassName}`);
        console.log(`   • Core Files in Output: ${coreFilesInOutput}`);
        console.log(`   • Application Classes in Output: ${appClassesInOutput}`);
        console.log(`   • ExtJS Classes (non-core) in Output: ${extjsClassesInOutput}`);
        console.log(`   • Total Unique Files in Output: ${sortedFiles.length}`);
        if (config.production && unminifiedJsSize > 0) {
            console.log(`   • JavaScript: ${(Buffer.byteLength(finalJs, 'utf8') / 1024 / 1024).toFixed(2)} MB (minified from ${(unminifiedJsSize / 1024 / 1024).toFixed(2)} MB)`);
        } else {
            console.log(`   • JavaScript: ${(Buffer.byteLength(finalJs, 'utf8') / 1024 / 1024).toFixed(2)} MB`);
        }
        console.log(`   • CSS: ${(finalCss.length / 1024 / 1024).toFixed(2)} MB`);
        console.log(`   • Build ID: ${buildId}`);
        console.log(`   • Output: ${config.buildDir}`);
        console.log(`   • Parsing Method: AST-based (more reliable than regex)`);
        
        // ExtJS verification
        if (finalJs.includes('Ext.define')) {
            console.log(`   ✅ Bundle includes Ext.define function`);
        } else {
            console.log(`   ⚠️  Bundle may be missing Ext.define - runtime errors likely`);
            console.log(`   💡 Ensure your ExtJS SDK includes core files or use a pre-built bundle`);
        }
        
        if (coreFilesInOutput === 0 && !hasCoreBundle) { // Check if no core files AND no bundle was identified
            console.log(`\n❌ WARNING: No ExtJS core files were included!`);
            console.log(`💡 This build will likely fail at runtime. Please:`);
            console.log(`   • Check that --ext-path points to a valid ExtJS SDK`);
            console.log(`   • Ensure build/ext-all-debug.js or packages/core/src/ exists`);
            console.log(`   • Verify ExtJS SDK is properly extracted/installed`);
        }
        
    } catch (error) {
        console.error(`❌ Build failed: ${error.message}`);
        console.error(error.stack);
        throw error;
    }
}

// --- CLI Support ---

function parseCliArguments() {
    const args = process.argv.slice(2);
    const options = {};
    
    for (let i = 0; i < args.length; i += 2) {
        const key = args[i].replace(/^--/, '');
        const value = args[i + 1];
        
        switch (key) {
            case 'app-json':
                options.appJsonPath = value;
                break;
            case 'workspace-json':
                options.workspaceJsonPath = value;
                break;
            case 'build-dir':
                options.buildDir = value;
                break;
            case 'profile':
                options.buildProfile = value;
                break;
            case 'ext-path':
                options.extPath = value;
                break;
            case 'index':
                options.indexPath = value;
                break;
            case 'no-minify':
                options.minifyJs = false;
                options.minifyCss = false;
                break;
            case 'debug-extjs':
                options.debugExtJS = true;
                break;
            case 'force-minimal-core':
                options.forceMinimalCore = value === 'true' || value === undefined; // Treat presence as true
                break;
        }
    }
    
    return options;
}

// --- ExtJS Debugging Utilities ---

async function debugExtJSSetup(extPath) {
    console.log(`\n🔍 ExtJS SDK Debugging Information`);
    console.log(`📁 ExtJS Path: ${extPath}`);
    
    if (!await fs.pathExists(extPath)) {
        console.log(`❌ ExtJS path does not exist!`);
        return;
    }
    
    console.log(`✅ ExtJS path exists`);
    
    // Check for common ExtJS files and directories
    const checkPaths = [
        'build/ext-all.js',
        'build/ext-all-debug.js', 
        'ext-all.js',
        'ext-all-debug.js',
        'packages/core/src/Ext.js',
        'packages/core/src/class/ClassManager.js',
        'classic/classic/src',
        'modern/modern/src'
    ];
    
    for (const checkPath of checkPaths) {
        const fullPath = path.join(extPath, checkPath);
        const exists = await fs.pathExists(fullPath);
        const icon = exists ? '✅' : '❌';
        console.log(`   ${icon} ${checkPath}`);
        
        if (exists && checkPath.includes('ClassManager.js')) {
            try {
                const content = await fs.readFile(fullPath, 'utf-8');
                const hasDefine = content.includes('Ext.define') || content.includes('define');
                const hasClassManager = content.includes('ClassManager') || content.includes('Ext.ClassManager');
                console.log(`      Contains define: ${hasDefine ? '✅' : '❌'}`);
                console.log(`      Contains ClassManager: ${hasClassManager ? '✅' : '❌'}`);
                console.log(`      File size: ${(content.length / 1024).toFixed(1)} KB`);
                console.log(`      Preview: ${content.substring(0, 100)}...`);
            } catch (e) {
                console.log(`      ❌ Could not read file: ${e.message}`);
            }
        }
    }
    
    // Check ExtJS version if possible
    const versionFiles = ['version.txt', 'VERSION', 'package.json'];
    for (const versionFile of versionFiles) {
        const versionPath = path.join(extPath, versionFile);
        if (await fs.pathExists(versionPath)) {
            try {
                const content = await fs.readFile(versionPath, 'utf-8');
                console.log(`📝 Version info from ${versionFile}:`);
                console.log(`   ${content.substring(0, 200)}`);
                break;
            } catch (e) {
                // ignore
            }
        }
    }
}

// --- Package Dependencies Check ---

function checkDependencies() {
    const required = ['fs-extra', 'terser', 'sass', 'clean-css', '@babel/parser', '@babel/traverse', '@babel/types'];
    const missing = [];
    
    for (const dep of required) {
        try {
            require.resolve(dep);
        } catch (e) {
            missing.push(dep);
        }
    }
    
    if (missing.length > 0) {
        console.error(`❌ Missing required dependencies: ${missing.join(', ')}`);
        console.error(`\nInstall them with:`);
        console.error(`npm install --save-dev ${missing.join(' ')}`);
        process.exit(1);
    }
}

// --- Main Execution ---

if (require.main === module) {
    checkDependencies();
    
    const options = parseCliArguments();
    
    console.log(`ExtJS Build Tool v2.0.0 (AST-powered)\n`);
    
    // Debug ExtJS setup if requested
    if (options.debugExtJS) {
        debugExtJSSetup(options.extPath || DEFAULT_CONFIG.extPath).then(() => {
            console.log(`\n💡 Run without --debug-extjs to perform actual build`);
        }).catch(err => {
            console.error("Debug failed:", err.message);
        });
        return;
    }
    
    buildExtApp(options).catch(err => {
        console.error("💥 Build failed:", err.message);
        console.error("\n💡 Troubleshooting tips:");
        console.error("   • Run with --debug-extjs to check ExtJS SDK setup.");
        console.error("   • Ensure --ext-path points to valid ExtJS installation");
        console.error("   • Check that ExtJS contains build/ext-all-debug.js or core source files");
        process.exit(1);
    });
}

module.exports = { buildExtApp };