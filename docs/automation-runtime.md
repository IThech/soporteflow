# Automation runtime — 5.4V-D

V-A persiste hechos; V-B entrega webhooks; V-C ejecuta acciones internas; n8n es un receptor
externo de V-B. No se instala ni inicia un scheduler, cron, daemon o temporizador periódico.
Los productores solo persisten intenciones en la transacción de dominio. Un error creando
esa intención sí revierte la mutación; un fallo de red posterior al commit no la revierte.

## Entradas reales

| Función                          | Archivo de servicio        | Lote                       | Lease     | Reintentos/red                                                       |
| -------------------------------- | -------------------------- | -------------------------- | --------- | -------------------------------------------------------------------- |
| processAutomationExecutions      | automation-processor.ts    | 25 por defecto, máximo 100 | 5 minutos | Hasta 3 reclamaciones abandonadas; fallo de acción terminal; sin red |
| processDueNotificationDeliveries | notification-deliveries.ts | 25 por defecto, máximo 100 | 5 minutos | 5 intentos, backoff; proveedor actual no configurado                 |
| processDueWebhookDeliveries      | webhook-deliveries.ts      | 25 por defecto, máximo 100 | 5 minutos | 5 intentos, backoff 1m/5m/30m/2h, HTTP 10s                           |

Todos viven en src/lib/server/services y reciben el cliente DB explícito.
Usan claims y comprobación de lease al confirmar resultado; no implican exactly-once.
Los procesadores de entregas devuelven claimed/sent/retried/failed/leaseLost.
El de automatizaciones informa estados de ejecución y se consulta su historial administrativo.
No pasan secretos en logs. Los adaptadores de prueba inyectados no son configuración de producción.

El email actual utiliza UnconfiguredNotificationEmailSender: no existe transporte SMTP/API
real y responde PROVIDER_NOT_CONFIGURED. No hay timeout de red aplicable a ese adaptador.
Antes de incorporar un proveedor real se deberá exigir timeout/cancelación de transporte;
no asumir que el lease cancela una promesa colgada. No se añade proveedor en V-D.

La llamada HTTP tiene timeout; resolución DNS y consultas DB no tienen aquí un límite global
de ejecución del runner. Configurar límites operativos/DB y monitorización en 5.4W.
Un lote secuencial de 100 entregas lentas puede durar más de cinco minutos: leases de filas
aún no atendidas pueden vencer. No prometer exclusión absoluta entre workers ni exactly-once.
Antes de paralelizar runners validar esta interacción y dimensionar lote/leases en PostgreSQL real.

## Orden sugerido, no dependencia obligatoria

1. processAutomationExecutions: puede generar nuevas notificaciones/webhooks.
2. processDueNotificationDeliveries.
3. processDueWebhookDeliveries.
4. Retención con frecuencia menor y ventanas aprobadas.

Otro orden no pierde intenciones confirmadas: quedarían para la siguiente invocación.
No hace falta bloquear los tres consumidores hasta terminar todos los anteriores.
El futuro runner debe aislar errores por consumidor y evitar un bucle no acotado para
"drenar todo": V-C puede producir más eventos. Supervisar antigüedad y crecimiento de colas.

## Retención existente

- deleteOldAutomationExecutions, automation-rules.ts: terminales, lote acotado, nunca pending/processing.
- deleteOldNotificationDeliveries, notification-deliveries.ts: sent/failed anteriores al corte.
- deleteOldWebhookDeliveries, webhook-deliveries.ts: sent/failed anteriores al corte.

Los dos helpers de entregas NO tienen límite por lote: no programar borrados masivos
sin revisar volumen/plan y ventanas en 5.4W. No se ejecutan automáticamente.
No borrar eventos usados por intenciones. Las versiones de secreto referenciadas se conservan.
Tras borrar ejecuciones, no está soportado refanout/replay histórico: la unicidad vivía en
esas filas. Definir deduplicación durable antes de añadir replay.
No se invoca ningún helper de retención sobre datos reales durante esta etapa.

## Observabilidad y puesta en servicio futura

Registrar solo conteos, IDs operativos y códigos seguros. No cuerpo receptor, firmas,
cookies, secretos ni cadenas de conexión. Revisar controles de acceso/retención de ejecuciones
n8n: sus datos también contienen eventos organizativos.
Supervisar pending/retry antiguos, failed, leaseLost, intentos, latencia y crecimiento por tenant.
V-C tiene profundidad máxima 5, máximo 100 reglas activas y 10 acciones por regla; eso NO
equivale a un presupuesto global de cola. Planificar backpressure y límites de tasa.

5.4W: PostgreSQL independiente, workers simultáneos, expiración de leases, interbloqueos,
pérdida de conexión/ack, configuración staging, runner y shutdown, alertas, claves y rotación,
revisión de logs/secretos y seguridad de red. Probar el receptor n8n desplegado y sus proxies.
Sin callbacks privilegiados; cualquier futura API M2M necesita diseño propio de scopes,
revocación, rotación, auditoría y rate limiting. No implementado aquí.
