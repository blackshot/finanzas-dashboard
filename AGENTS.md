# Dashboard analisis finanzas

Este dashboard permite analizar las finanzas a partir de los reportes CSV de Mercado Pago.

# Origen datos
- Los CSV (reserve-release-*.csv / settlement_*.csv) se cargan en el navegador al abrir el dashboard; el servidor no lee ni guarda datos.
- Renombres, categorías, etiquetas y presupuesto viven en el localStorage del navegador (clave `finanzas.configuracion`).
- ./data y ./config son copias locales del usuario; no los usa el servidor ni entran en la imagen Docker.

# Ejecución
- Docker: `docker compose up -d --build` → http://localhost:3000
- Desarrollo: `bun dev`
