import { join } from "path";

/**
 * Servidor estático del dashboard.
 * No lee ni guarda datos: los CSV se procesan en el navegador y la configuración
 * (renombres, categorías, presupuesto) vive en el localStorage de cada navegador.
 */
const ROOT = import.meta.dir;
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.PORT ?? 3000);

// El lector de CSV (TypeScript) se empaqueta para el navegador al iniciar.
const build = await Bun.build({
  entrypoints: [join(ROOT, "src/loader.ts")],
  target: "browser",
  format: "iife",
  minify: true,
});
if (!build.success) {
  console.error("No se pudo compilar src/loader.ts:", build.logs);
  process.exit(1);
}
const loaderJs = await build.outputs[0]!.text();

const js = { "Content-Type": "text/javascript; charset=utf-8" };

const server = Bun.serve({
  port: PORT,
  routes: {
    "/loader.js": new Response(loaderJs, { headers: js }),
    "/vendor/echarts.min.js": new Response(Bun.file(join(ROOT, "node_modules/echarts/dist/echarts.min.js")), { headers: js }),
    "/health": new Response("ok"),
  },
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (path.includes("..")) return new Response("No encontrado", { status: 404 });
    const file = Bun.file(join(PUBLIC_DIR, path));
    if (await file.exists()) return new Response(file);
    return new Response("No encontrado", { status: 404 });
  },
});

console.log(`💰 Dashboard de finanzas en ${server.url}`);
