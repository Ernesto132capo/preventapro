# SQLite para la compilación de Android

`expo-sqlite` 14.0.6 descarga este archivo al compilar con Gradle. El build
`c47901ea-88c1-497f-84c2-c31e3ed80de3` falló en esa descarga con
`java.net.SocketException: Network is unreachable`.

Se conserva el archivo oficial, sin modificar. El hook `eas-build-post-install`
verifica su hash y cambia la fuente de la tarea Gradle `downloadSQLite` por la URI
de ese archivo local. La extracción y la compilación siguen usando las tareas
originales de `expo-sqlite`. No cambia la versión de SQLite ni sus opciones de
compilación.

El segundo build, `d928cf76-dad7-4c66-90b7-99542a92f110`, demostró que copiar el
archivo a una ubicación supuesta de caché no era suficiente: el hook sí se ejecutó,
pero Gradle volvió a solicitar la URL remota. Por eso ahora se modifica directamente
la fuente de la tarea y no se supone dónde está su directorio de salida.

- Origen: https://www.sqlite.org/2024/sqlite-amalgamation-3450300.zip
- Descargado por HTTPS el 2 de noviembre de 2026.
- Tamaño: 2 733 959 bytes.
- SHA-256: `ea170e73e447703e8359308ca2e4366a3ae0c4304a8665896f068c736781c651`.

`mobile/scripts/prepare-sqlite-build.cjs` comprueba el hash y que el módulo siga
esperando esta versión. Al actualizar `expo-sqlite`, revisar también este archivo
y el hook.
