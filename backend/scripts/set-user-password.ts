import "dotenv/config";
import { pool } from "../src/db/pg";
import { hashPassword } from "../src/services/auth";

function readHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("Ejecuta este comando desde una terminal interactiva para ingresar la contraseña de forma oculta."));
  }

  return new Promise((resolve, reject) => {
    let value = "";
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();

    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("Operación cancelada."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };

    input.on("data", onData);
  });
}

async function main() {
  const code = process.argv[2]?.trim();
  if (!code) throw new Error("Indica el código del preventista: npm run user:set-password -- PV001");

  const password = await readHidden("Nueva contraseña (mínimo 8 caracteres): ");
  if (password.length < 8 || password.length > 128) throw new Error("La contraseña debe tener entre 8 y 128 caracteres.");
  const confirmation = await readHidden("Repite la contraseña: ");
  if (password !== confirmation) throw new Error("Las contraseñas no coinciden.");

  const passwordHash = await hashPassword(password);
  const { rows } = await pool.query(
    "UPDATE users SET password_hash = $2, updated_at = NOW() WHERE lower(code) = lower($1) RETURNING id",
    [code, passwordHash]
  );
  if (rows.length === 0) throw new Error(`No existe un preventista con código ${code}.`);
  console.log(`Contraseña actualizada para ${code}.`);
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
