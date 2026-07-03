import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const archiveRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(archiveRoot, '..', '..');

function parseSource(filePath) {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function getPropertyName(nameNode) {
  if (
    ts.isIdentifier(nameNode)
    || ts.isStringLiteral(nameNode)
    || ts.isNumericLiteral(nameNode)
  ) {
    return nameNode.text;
  }
  return null;
}

function getNamedImports(filePath) {
  const sourceFile = parseSource(filePath);
  const imports = new Map();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !statement.moduleSpecifier) {
      continue;
    }
    const namedBindings = statement.importClause.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }
    for (const element of namedBindings.elements) {
      imports.set(element.name.text, statement.moduleSpecifier.text);
    }
  }

  return imports;
}

function getTopLevelReturnedObject(filePath, functionName) {
  const sourceFile = parseSource(filePath);

  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== functionName || !statement.body) {
      continue;
    }
    for (const bodyStatement of statement.body.statements) {
      if (
        ts.isReturnStatement(bodyStatement)
        && bodyStatement.expression
        && ts.isObjectLiteralExpression(bodyStatement.expression)
      ) {
        return bodyStatement.expression;
      }
    }
  }

  return null;
}

function collectObjectPaths(objectLiteral, prefix = [], paths = new Set()) {
  for (const property of objectLiteral.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = getPropertyName(property.name);
      if (!name) {
        continue;
      }
      if (ts.isObjectLiteralExpression(property.initializer)) {
        collectObjectPaths(property.initializer, [...prefix, name], paths);
      } else {
        paths.add([...prefix, name].join('.'));
      }
      continue;
    }

    if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property)) {
      const name = getPropertyName(property.name);
      if (name) {
        paths.add([...prefix, name].join('.'));
      }
    }
  }

  return paths;
}

function collectIpcRendererPaths(ipcRendererPath) {
  const imports = getNamedImports(ipcRendererPath);
  const bridgeObject = getTopLevelReturnedObject(ipcRendererPath, 'createIpcRenderer');
  if (!bridgeObject) {
    throw new Error(`Unable to find createIpcRenderer return object in ${ipcRendererPath}`);
  }

  const paths = new Set();
  for (const property of bridgeObject.properties) {
    if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      const name = getPropertyName(property.name);
      if (name) {
        paths.add(name);
      }
      continue;
    }

    if (
      !ts.isSpreadAssignment(property)
      || !ts.isCallExpression(property.expression)
      || !ts.isIdentifier(property.expression.expression)
    ) {
      continue;
    }

    const factoryName = property.expression.expression.text;
    const modulePath = imports.get(factoryName);
    if (!modulePath) {
      continue;
    }

    const domainPath = path.resolve(path.dirname(ipcRendererPath), `${modulePath}.ts`);
    const domainObject = getTopLevelReturnedObject(domainPath, factoryName);
    if (!domainObject) {
      throw new Error(`Unable to find ${factoryName} return object in ${domainPath}`);
    }
    for (const apiPath of collectObjectPaths(domainObject)) {
      paths.add(apiPath);
    }
  }

  return paths;
}

async function listBridgeDomains(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('Bridge.ts'))
    .map((entry) => entry.name)
    .sort();
}

const formalDir = path.join(repoRoot, 'desktop', 'src', 'bridge', 'domains');
const archiveDir = path.join(archiveRoot, 'src', 'bridge', 'domains');

const [formalDomains, archiveDomains] = await Promise.all([
  listBridgeDomains(formalDir),
  listBridgeDomains(archiveDir),
]);

const archiveDomainSet = new Set(archiveDomains);
const missingDomains = formalDomains.filter((name) => !archiveDomainSet.has(name));

if (missingDomains.length > 0) {
  console.error('Missing Electron bridge domain compatibility files:');
  for (const name of missingDomains) {
    console.error(`- ${name}`);
  }
  process.exit(1);
}

const formalIpcRenderer = path.join(repoRoot, 'desktop', 'src', 'bridge', 'ipcRenderer.ts');
const archiveIpcRenderer = path.join(archiveRoot, 'src', 'bridge', 'ipcRenderer.ts');
const formalPaths = collectIpcRendererPaths(formalIpcRenderer);
const archivePaths = collectIpcRendererPaths(archiveIpcRenderer);
const missingApiPaths = [...formalPaths]
  .filter((apiPath) => !archivePaths.has(apiPath))
  .sort();

if (missingApiPaths.length > 0) {
  console.error('Missing Electron bridge API compatibility paths:');
  for (const apiPath of missingApiPaths) {
    console.error(`- ${apiPath}`);
  }
  process.exit(1);
}

console.log(
  `Bridge compatibility check passed: ${formalDomains.length} formal domains and ${formalPaths.size} formal API paths covered.`,
);
