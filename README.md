# Dashboard de finanzas

Dashboard (Bun + ECharts) para analizar los reportes CSV de Mercado Pago.

- **El servidor solo entrega la página.** No lee ni guarda datos.
- **Los CSV se cargan en el navegador al abrir el dashboard** y se procesan ahí mismo. Nunca se suben a un servidor y se olvidan al recargar la pestaña.
- **Renombres, categorías, tipos, etiquetas y presupuesto se guardan en el `localStorage` del navegador.**

## Levantar con Docker

```bash
docker compose up -d --build     # http://localhost:3000
docker compose down              # detener
```

Por defecto solo se puede abrir desde este equipo. Para verlo desde otros dispositivos de tu red, cambia el puerto en `docker-compose.yml` a `"3000:3000"`.

Sin compose:

```bash
docker build -t finanzas-dashboard .
docker run -d --name finanzas -p 127.0.0.1:3000:3000 finanzas-dashboard
```

### Imagen publicada (GitHub Container Registry)

Cada push a `main` ejecuta `.github/workflows/docker-publish.yml`. El workflow compila la imagen para `linux/amd64` y `linux/arm64` y la publica como:

- `ghcr.io/blackshot/finanzas-dashboard:latest`
- `ghcr.io/blackshot/finanzas-dashboard:sha-<commit>`
- `ghcr.io/blackshot/finanzas-dashboard:<AAAA-MM-DD>`

Para usar la imagen publicada en vez de compilarla:

```bash
docker compose pull && docker compose up -d
```

Si el paquete es privado, primero inicia sesión con `docker login ghcr.io -u blackshot`, usando un token con permiso `read:packages`.

## Desarrollo sin Docker

```bash
bun install
bun dev            # http://localhost:3000, se reinicia solo al cambiar el código
```

## Uso

1. Descarga desde Mercado Pago el reporte de **liberaciones** (`reserve-release-*.csv`), uno o varios meses.
2. Abre el dashboard y arrastra los CSV a la pantalla de carga. Ahí ves cuántos movimientos tiene cada archivo y cuáles no se reconocen.
3. Presiona **Ver dashboard →**. Con **📂 Cargar CSV** puedes agregar o quitar archivos después.

El reporte de **liquidaciones** (`settlement_*.csv`) también se acepta, pero solo se usa para fechas que el de liberaciones no cubre, porque le faltan las transferencias enviadas.

## Configuración (⚙)

Se guarda solo en el navegador donde la creaste. Si borras los datos del navegador o usas otro equipo, se pierde. Por eso, desde **⚙ Configuración** puedes:

- **Descargar respaldo**: un `.json` con todos tus renombres, categorías, tipos, etiquetas y presupuesto.
- **Importar respaldo**: suma lo importado a lo que ya tienes. También acepta los antiguos `config/comercios.json`, `etiquetas.json` y `ajustes.json`.
- **Borrar configuración**.

Ejemplo de respaldo:

```json
{
  "comercios": {
    "cuenta15082369": { "nombre": "Arriendo", "categoria": "Vivienda", "original": "Cuenta terminada en 2369" },
    "cuenta19499968": { "tipo": "interno", "original": "Cuenta terminada en 9968" }
  },
  "etiquetas": { "r:176699857086": { "nota": "pago adelantado" } },
  "ajustes": { "presupuestoMensual": 1500000 }
}
```

### Renombrar un comercio

Haz clic en ✏️ junto a cualquier nombre, o escribe en la tabla **Tus comercios y destinatarios**.

- El nuevo nombre se usa en todo el dashboard.
- Si usas el nombre de otro comercio, ambos se suman como uno solo.
- **↺ Restaurar original** vuelve al nombre del CSV.

## Exportar reporte

**⬇ Exportar HTML** descarga un único `.html` con datos, gráficos y estilos incluidos. Se abre sin servidor ni internet y es de solo lectura.

Ojo: contiene todos los movimientos cargados. Ocultar los montos con el ojo es solo visual.

## Clasificación automática (`src/loader.ts`)

| Dato | Origen |
|---|---|
| Comercio | `SALE_DETAIL`, sin el prefijo del procesador (`Payu *`, `Mercadopago *`, `Tuu*`…) y con nombres unificados |
| Destinatario de transferencias | `PAYOUT_BANK_ACCOUNT_NUMBER` → "Cuenta terminada en 2369" |
| Medio de pago | `SEGMENT_DETAIL`: tarjeta virtual o física, NFC, pago de cuentas, transferencia |
| Categoría | Palabras clave del comercio (`CATEGORY_RULES`) |
| Apartados | `AM-to-POT` / `POT-to-AM`: cuentan como ahorro, no como gasto |

`src/loader.ts` se empaqueta para el navegador al iniciar el servidor (se sirve como `/loader.js`).
