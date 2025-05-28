/**
 * Custom ExtJS Application Bundler
 *
 * This script takes an entry Application.js file and attempts to bundle it
 * and its dependencies (extend, requires, controllers, models, views, stores, mainView)
 * into a single output file.
 *
 * Limitations:
 * - Uses regex for parsing, which might not cover all edge cases.
 * - Relies on standard ExtJS naming conventions and folder structures.
 * - Does not perform minification or other advanced build optimizations.
 * - Primarily designed for Ext.define constructs.
 */
const fs = require('fs');
const path = require('path');

/**
 * Resolves a fully qualified ExtJS class name to a file path.
 * @param {string} className - The class name (e.g., "CMDAPP.view.Main", "Ext.Button").
 * @param {string} appName - The application's namespace (e.g., "CMDAPP").
 * @param {string} appSourceDir - Absolute path to the application's source code (e.g., /path/to/CMDAPP/app).
 * @param {string} extSourceDir - Absolute path to the ExtJS framework source (e.g., /path/to/CMDAPP/ext/packages/core/src).
 * @returns {string|null} The absolute file path or null if not resolvable by convention.
 */
function resolveClassNameToPath(className, appName, appSourceDir, extSourceDir) {
    if (!className) return null;
    const parts = className.split('.');
    if (parts.length === 0) return null;

    if (parts[0] === appName) {
        // AppName.folder.SubFolder.FileName -> appSourceDir/folder/SubFolder/FileName.js
        const relativePathParts = parts.slice(1);
        return path.join(appSourceDir, ...relativePathParts) + '.js';
    } else if (parts[0] === 'Ext') {
        // Ext.folder.SubFolder.FileName -> extSourceDir/folder/SubFolder/FileName.js
        const relativePathParts = parts.slice(1);
        return path.join(extSourceDir, ...relativePathParts) + '.js';
    } else {
        // For other namespaces, this script assumes they might be structured like app classes
        // or are already fully pathed. This part might need enhancement for complex setups.
        console.warn(`[PathResolver] Cannot conventionally resolve path for non-appName/non-Ext class: ${className}. Assuming it might be a pre-loaded or non-file dependency.`);
        return null;
    }
}

/**
 * Extracts the class name defined by Ext.define.
 * @param {string} fileContent - The content of the JavaScript file.
 * @returns {string|null} The defined class name or null.
 */
function getDefinedClassName(fileContent) {
    const match = /Ext\.define\s*\(\s*['"]([^'"]+)['"]/.exec(fileContent);
    return match ? match[1] : null;
}

/**
 * Resolves a potentially shorthand class name (e.g., ".MyController", "User") to its full name.
 * @param {string} name - The shorthand or full name.
 * @param {string} kind - The kind of MVC artifact (e.g., "controller", "view").
 * @param {string} definedClassName - The class name of the file being parsed.
 * @param {string} appName - The application's namespace.
 * @returns {string|null} The fully resolved class name or the original name if already full.
 */
function resolveContextualName(name, kind, definedClassName, appName) {
    if (!name || !appName || !kind) return name; // Return original if not enough info

    if (name.startsWith('.')) { // e.g., ".MyController" in an Application class
        return `${appName}.${kind}${name}`; // Results in "AppName.controller.MyController"
    }
    if (name.indexOf('.') === -1) { // e.g., "Users" for kind "controller"
        return `${appName}.${kind}.${name}`; // Results in "AppName.controller.Users"
    }
    return name; // Assumed to be a full class name already
}

/**
 * Extracts dependencies from an Ext.define block.
 * @param {string} fileContent - The content of the JavaScript file.
 * @param {string} filePath - The path of the file being parsed (for logging).
 * @param {string} appName - The application's namespace.
 * @returns {{extend: string|null, classNames: string[]}}
 */
function extractDependencies(fileContent, filePath, appName) {
    const definedClassName = getDefinedClassName(fileContent);
    const dependencies = { extend: null, classNames: [] };

    const defineRegex = /Ext\.define\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\{[\s\S]*?\})\s*(?:,\s*function\s*\(.*?\)\s*\{[\s\S]*?\}\s*)?\);?/m;
    const match = defineRegex.exec(fileContent);

    if (!match || !match[2]) {
        // console.warn(`[Parser] Could not find Ext.define block in ${filePath}`);
        return dependencies;
    }

    const configStr = match[2]; // The entire config object as a string "{...}"

    function extractStringValue(key) {
        const regex = new RegExp(`\\b${key}\\s*:\\s*['"]([^'"]+)['"]`);
        const strMatch = regex.exec(configStr);
        return (strMatch && strMatch[1]) ? strMatch[1] : null;
    }

    function extractStringArray(key) {
        const regex = new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`);
        const arrMatch = regex.exec(configStr);
        if (arrMatch && arrMatch[1]) {
            return arrMatch[1].split(',')
                .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
                .filter(s => s);
        }
        return [];
    }

    dependencies.extend = extractStringValue('extend');

    dependencies.classNames.push(...extractStringArray('requires'));

    const mvcKinds = {
        controllers: 'controller',
        models: 'model',
        views: 'view',
        stores: 'store',
        profiles: 'profile'
    };

    if (appName) {
        for (const [key, kind] of Object.entries(mvcKinds)) {
            const names = extractStringArray(key);
            names.forEach(name => {
                const resolvedName = resolveContextualName(name, kind, definedClassName, appName);
                if (resolvedName) dependencies.classNames.push(resolvedName);
            });
        }

        const mainViewName = extractStringValue('mainView');
        if (mainViewName) {
            let resolvedMainView;
            if (mainViewName.startsWith(appName + '.') || mainViewName.startsWith('Ext.')) {
                resolvedMainView = mainViewName;
            } else if (mainViewName.includes('.')) { // e.g., 'main.Main'
                resolvedMainView = `${appName}.view.${mainViewName}`;
            } else { // e.g., 'MainViewport'
                resolvedMainView = `${appName}.view.${mainViewName}`;
            }
            if (resolvedMainView) dependencies.classNames.push(resolvedMainView);
        }
    }
    dependencies.classNames = [...new Set(dependencies.classNames.filter(Boolean))]; // Unique and valid names
    return dependencies;
}

/**
 * Recursively collects files and their dependencies in an order suitable for concatenation.
 * @param {string} filePath - Absolute path to the current file to process.
 * @param {string} appName - The application's namespace.
 * @param {string} appSourceDir - Absolute path to the application's source directory.
 * @param {string} extSourceDir - Absolute path to the ExtJS framework source directory.
 * @param {Set<string>} processedFiles - Set of absolute file paths already added to buildOrder.
 * @param {string[]} buildOrder - Array to store absolute file paths in concatenation order.
 * @param {Map<string, string>} fileContentCache - Cache for file contents.
 * @param {Set<string>} visiting - Set of absolute file paths currently in the recursion stack for cycle detection.
 */
function collectFilesRecursively(filePath, appName, appSourceDir, extSourceDir, processedFiles, buildOrder, fileContentCache, visiting) {
    if (!filePath) return;
    const absoluteFilePath = path.resolve(filePath);

    if (processedFiles.has(absoluteFilePath)) {
        return; // Already processed and added to buildOrder
    }

    if (visiting.has(absoluteFilePath)) {
        console.warn(`[Collector] Circular dependency detected for ${path.relative(process.cwd(), absoluteFilePath)}. Skipping further recursion for this path.`);
        return; // Cycle detected
    }

    visiting.add(absoluteFilePath); // Mark as currently visiting

    // Ensure 'visiting' is cleared if an error occurs before normal exit
    let successfullyProcessedCurrentFile = false;


    let fileContent;
    if (fileContentCache.has(absoluteFilePath)) {
        fileContent = fileContentCache.get(absoluteFilePath);
    } else {
        try {
            fileContent = fs.readFileSync(absoluteFilePath, 'utf-8');
            fileContentCache.set(absoluteFilePath, fileContent);
        } catch (e) {
            console.warn(`[Collector] Warning: Could not read file ${absoluteFilePath}. Skipping. ${e.message}`);
            processedFiles.add(absoluteFilePath);
            visiting.delete(absoluteFilePath); // Remove from visiting as we are aborting this path
            return;
        }
    }

    const dependencies = extractDependencies(fileContent, absoluteFilePath, appName);

    // 1. Process 'extend' dependency first
    if (dependencies.extend) {
        const extendPath = resolveClassNameToPath(dependencies.extend, appName, appSourceDir, extSourceDir);
        if (extendPath) {
            collectFilesRecursively(extendPath, appName, appSourceDir, extSourceDir, processedFiles, buildOrder, fileContentCache, visiting);
        } else {
            console.warn(`[Collector] Could not resolve path for extended class: ${dependencies.extend} in ${absoluteFilePath}`);
        }
    }

    // 2. Process other class name dependencies (requires, controllers, views, etc.)
    for (const depClass of dependencies.classNames) {
        const depPath = resolveClassNameToPath(depClass, appName, appSourceDir, extSourceDir);
        if (depPath) {
            collectFilesRecursively(depPath, appName, appSourceDir, extSourceDir, processedFiles, buildOrder, fileContentCache, visiting);
        } else {
            console.warn(`[Collector] Could not resolve path for required/dependent class: ${depClass} in ${absoluteFilePath}`);
        }
    }

    visiting.delete(absoluteFilePath); // Done visiting this node for the current recursive path

    // 3. Add current file to build order *after* all its dependencies have been processed.
    // This ensures that files are added in an order where dependencies come first.
    if (!processedFiles.has(absoluteFilePath)) {
        buildOrder.push(absoluteFilePath);
        processedFiles.add(absoluteFilePath); // Mark as fully processed and added to buildOrder
    }    
}


/**
 * Main function to drive the build process.
 */
function main() {
    const args = process.argv.slice(2);
    if (args.length < 5) {
        console.error('Usage: node custom_build.js <entryFile> <outputFile> <appName> <appSourceDir> <extJsSrcDir>');
        console.error('Example: node custom_build.js ./app/Application.js ./build/app.js CMDAPP ./app ../ext/packages/core/src');
        process.exit(1);
    }

    const [entryFilePath, outputFilePath, appName, appSourceDirRelative, extSourceDirRelative] = args;

    const projectRoot = process.cwd();
    const absoluteAppSourceDir = path.resolve(projectRoot, appSourceDirRelative);
    const absoluteExtSourceDir = path.resolve(projectRoot, extSourceDirRelative);
    const absoluteEntryFilePath = path.resolve(projectRoot, entryFilePath);
    const absoluteOutputFilePath = path.resolve(projectRoot, outputFilePath);

    console.log(`Starting build for ${appName}...`);
    console.log(`Entry file: ${absoluteEntryFilePath}`);
    console.log(`App source: ${absoluteAppSourceDir}`);
    console.log(`ExtJS source: ${absoluteExtSourceDir}`);
    console.log(`Output file: ${absoluteOutputFilePath}`);

    const processedFiles = new Set();
    const buildOrder = [];
    const fileContentCache = new Map();
    const visiting = new Set(); // For cycle detection

    collectFilesRecursively(
        absoluteEntryFilePath,
        appName,
        absoluteAppSourceDir,
        absoluteExtSourceDir,
        processedFiles,
        buildOrder,
        fileContentCache,
        visiting
    );

    let combinedContent = `// Custom Build generated on ${new Date().toISOString()}\n`;
    combinedContent += `// Entry Point: ${entryFilePath}\n`;
    combinedContent += `// Application: ${appName}\n\n`;
    combinedContent += `//---------------------------------------------------------------------\n`;
    combinedContent += `// Framework and Application Files (in dependency order)\n`;
    combinedContent += `//---------------------------------------------------------------------\n\n`;


    console.log('\nFiles to be included in order:');
    buildOrder.forEach(fp => console.log(` - ${path.relative(projectRoot, fp)}`));

    for (const filePath of buildOrder) {
        if (fileContentCache.has(filePath)) {
            combinedContent += `/* Source: ${path.relative(projectRoot, filePath)} */\n`;
            combinedContent += fileContentCache.get(filePath) + '\n\n';
        } else {
            // This should ideally not happen if logic is correct
            console.warn(`[Bundler] Content for ${filePath} not found in cache. File might have been unreadable or skipped.`);
        }
    }

    try {
        fs.mkdirSync(path.dirname(absoluteOutputFilePath), { recursive: true });
        fs.writeFileSync(absoluteOutputFilePath, combinedContent, 'utf-8');
        console.log(`\nBuild successfully created at: ${absoluteOutputFilePath}`);
    } catch (e) {
        console.error(`\nError writing output file: ${e.message}`);
        process.exit(1);
    }
}

main();
