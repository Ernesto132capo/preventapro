const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
// El núcleo monetario vive dentro del backend para que su despliegue siga siendo autónomo.
config.watchFolders = [...config.watchFolders, path.resolve(__dirname, "../backend/src/shared")];
// Los helpers que Babel añade al núcleo externo pertenecen al runtime del móvil.
config.resolver.nodeModulesPaths = [
  ...config.resolver.nodeModulesPaths,
  path.resolve(__dirname, "node_modules"),
];

module.exports = config;
