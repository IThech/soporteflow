# n8n — consumidor externo de webhooks V-B (5.4V-D)

## Decisión y configuración

No existe motor n8n en SoporteFlow. Usar exactamente /api/webhooks, webhook_subscriptions,
webhook_secrets y webhook_deliveries. Sin nuevas tablas, migración 0026, metadata cosmética,
dependencias, credenciales de acceso a n8n ni API de integración paralela.
RBAC: webhooks:manage para configurar, webhooks:view para consultar; organización por query
validada en servidor. La operación de dominio produce automation_event e intención en una
transacción; processDueWebhookDeliveries envía después del commit.

1. En n8n preparar un Webhook POST con Raw Body activado, Binary Data desactivado y
   respuesta mediante Respond to Webhook (no responder inmediatamente).
2. Configurar verificación, deduplicación durable y rama de error antes de activar.
3. Como administrador crear POST /api/webhooks?organizationId=<UUID> con:
   { name, targetUrl, eventTypes }. Usar Production Webhook URL HTTPS pública, por ejemplo
   https://n8n.example.com/webhook/soporteflow o https://tenant.n8n.cloud/webhook/soporteflow.
4. Transferir el secret devuelto una sola vez al entorno seguro del receptor. Nunca pegarlo
   en el workflow, en un nodo Set, en datos de ejecución, en URLs ni en este repositorio.
5. Activar/publicar el workflow desde n8n. No se automatiza mediante REST o CLI.
6. Verificar un evento sintético en staging y consultar historial V-B antes de uso real.

El catálogo es el existente: incident.created, incident.assigned, incident.reopened,
incident.priority_changed, incident.public_comment_added, sla.first_response_breached,
sla.resolution_breached, entre otros. No existe wildcard.
GET /api/webhooks/[id]/deliveries?organizationId=<UUID> reutiliza historial, intentos,
estado, código seguro y estado HTTP; nunca entrega secretos.

## Contrato y prueba del raw body

Envelope sin cambios: { id, type, schemaVersion, occurredAt, organizationId,
aggregate: { type, id }, data }. Es el envelope público V-B, no el registro interno V-A.

Se inspeccionó el código oficial: el Webhook con options.rawBody obtiene req.rawBody
y lo publica en binary.data.data como base64. El lector HTTP conserva un Buffer separado
del JSON parseado. La ruta soportada aquí usa ese binario inline, no JSON.stringify(body).
SoporteFlow envía UTF-8 application/json sin compresión; el proxy no debe transformar el cuerpo.

Fuentes verificadas (27/09/2026):

- [Webhook, referencia versionada n8n@1.121.0, rama Raw Body](https://github.com/n8n-io/n8n/blob/n8n%401.121.0/packages/nodes-base/nodes/Webhook/Webhook.node.ts).
- [Webhook actual, mismo contrato rawBody](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Webhook/Webhook.node.ts).
- [Lector HTTP y parsing separado](https://github.com/n8n-io/n8n/blob/master/packages/cli/src/middlewares/body-parser.ts).
- [Code sandbox y módulos permitidos](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Code/JavaScriptSandbox.ts).

La referencia antigua identifica el contrato inspeccionado, NO recomienda desplegar esa versión.
No se instaló ni ejecutó una instancia n8n. La suite ejecuta el ejemplo exacto de abajo con el
formato binario inspeccionado y con el body que entrega el procesador real V-B a su transporte.
Esto prueba interoperabilidad del contrato; el despliegue concreto y sus proxies se validan en staging.

## Code node: Verify HMAC

JavaScript, Run Once for All Items, directamente después del Webhook. Requiere Buffer,
require('crypto') con createHmac/timingSafeEqual y acceso autorizado a las variables indicadas.
En self-hosted, el administrador debe permitir únicamente crypto al runtime del Code node
(NODE_FUNCTION_ALLOW_BUILTIN=crypto); comprobar también la configuración del task runner
si se usa. No usar comodín de módulos ni ejecutar workflows no confiables en un runtime
que tiene acceso al secreto. Este cambio de infraestructura NO se realiza en V-D.

El ejemplo usa $env.SOPORTEFLOW_WEBHOOK_SECRET, opcionalmente
$env.SOPORTEFLOW_WEBHOOK_PREVIOUS_SECRET durante rotación, y
$env.SOPORTEFLOW_ORGANIZATION_ID como identidad esperada de esta suscripción.
Son configuración del receptor, no variables nuevas de SoporteFlow.
No se supone acceso genérico a credentials desde Code. n8n Cloud puede aceptar la URL,
pero este ejemplo NO se declara listo para Cloud si el plan/runtime no permite inyectar
el secreto de forma segura. En ese caso detener la activación y aprobar un mecanismo de
credenciales compatible; nunca sustituir HMAC por un token en query ni reserializar JSON.

<!-- BEGIN TESTED N8N CODE -->

```js
const { createHmac, timingSafeEqual } = require('crypto');
const reject = () => {
	throw new Error('SF_WEBHOOK_REJECTED');
};
const items = $input.all();
if (items.length !== 1) reject();
const item = items[0];
const headers = item.json?.headers ?? {};
const timestamp = headers['x-soporteflow-timestamp'];
const signature = headers['x-soporteflow-signature'];
const eventId = headers['x-soporteflow-event-id'];
const encoded = item.binary?.data?.data;
const secret = $env.SOPORTEFLOW_WEBHOOK_SECRET;
const previous = $env.SOPORTEFLOW_WEBHOOK_PREVIOUS_SECRET;
const organizationId = $env.SOPORTEFLOW_ORGANIZATION_ID;
if (
	typeof secret !== 'string' ||
	secret.length < 32 ||
	typeof organizationId !== 'string' ||
	!organizationId
)
	reject();
if (
	typeof timestamp !== 'string' ||
	!/^[0-9]{1,12}$/.test(timestamp) ||
	typeof signature !== 'string' ||
	!/^v1=[0-9a-f]{64}$/.test(signature) ||
	typeof eventId !== 'string' ||
	!eventId ||
	typeof encoded !== 'string' ||
	!encoded ||
	encoded.length > 45000
)
	reject();
const seconds = Number(timestamp);
if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(Date.now() / 1000) - seconds) > 300)
	reject();
// Raw Body inline base64 only. Reject storage references; never stringify item.json.body.
const raw = Buffer.from(encoded, 'base64');
if (raw.length === 0 || raw.length > 32768 || raw.toString('base64') !== encoded) reject();
const keys = [secret];
if (typeof previous === 'string' && previous.length >= 32) keys.push(previous);
const received = Buffer.from(signature.slice(3), 'hex');
let valid = false;
for (const key of keys) {
	const expected = createHmac('sha256', key)
		.update(timestamp + '.', 'utf8')
		.update(raw)
		.digest();
	if (timingSafeEqual(expected, received)) valid = true;
}
if (!valid) reject();
let event;
try {
	event = JSON.parse(raw.toString('utf8'));
} catch {
	reject();
}
if (
	!event ||
	typeof event !== 'object' ||
	event.id !== eventId ||
	event.organizationId !== organizationId ||
	event.schemaVersion !== 1 ||
	typeof event.type !== 'string' ||
	event.aggregate?.type !== 'incident' ||
	typeof event.aggregate.id !== 'string' ||
	!event.data ||
	typeof event.data !== 'object'
)
	reject();
// Pass only the verified envelope. Durable deduplication is the NEXT node, not static workflow data.
return [{ json: { event } }];
```

<!-- END TESTED N8N CODE -->

La firma sigue siendo v1=hex(HMAC-SHA256(secret, timestamp + "." + rawBody)).
El secreto se usa como texto tal como fue entregado, no decodificado de base64.
El timestamp está en segundos Unix. Se rechazan ±más de cinco minutos, formato inválido,
firma errónea, ausencia de binario, referencias a almacenamiento en lugar de base64,
event ID discordante y organización inesperada. Sin fallback.
El ID y la organización se contrastan con el envelope firmado; no se confía solo en headers.
Configurar On Error → salida de error → Respond to Webhook 401 con texto fijo, sin reenviar
error/stack/body. La rama de éxito es la única conectada a deduplicación y efectos.
No habilitar Continue On Fail hacia acciones; no devolver 200 antes de verificar.

## Workflow, deduplicación y respuesta

Webhook → Verify HMAC → ingreso/deduplicación durable → Respond 2xx → orquestación.
Alternativa sin inbox durable: completar el trabajo idempotente antes del 2xx, dentro del timeout.
Usar un almacenamiento externo con UNIQUE(subscription identity, event.id) y transacción.
No usar memoria ni workflow static data como exclusión concurrente.
Un duplicado ya completado puede responder 2xx sin repetir efectos. Un registro pendiente
solo puede reconocerse si existe un worker durable que garantiza retomarlo; no marcar
"procesado" antes de realizar trabajo sin recuperación. El ejemplo NO implementa ese almacén.

Entrega at-least-once, nunca exactly-once, con intentos limitados: no garantiza entrega
eventual ante caída permanente. Un retry conserva eventId/body, cambia timestamp/firma.
La ventana temporal no sustituye deduplicación.
Ejemplo externo: Switch event.type = incident.created, filtrar data.priority y escribir
idempotentemente en CRM/Sheets/Teams. No leer campos que el envelope no entrega.
V-C realiza acciones internas; n8n orquesta sistemas externos. No hay callback privilegiado
n8n → SoporteFlow, token M2M ni acción "send to n8n".

## Respuestas y operación

2xx → sent. 500 → retry. Timeout → retry. 429 → retry con Retry-After según V-B.
408/425 también reintentables; otros 4xx normalmente permanentes. 3xx no se siguen.
Cinco intentos máximo, backoff V-B 1m/5m/30m/2h, timeout de red 10s.
Un 2xx reconoce recepción; fallos posteriores del workflow son responsabilidad del receptor.
No usar ack temprano sin aceptación durable. Las caídas después del commit no revierten
incidencia ni automation_event.

Test URL /webhook-test/ solo mientras escucha el editor; Production /webhook/ exige
workflow activo/publicado. No se infiere automáticamente del path.
DELETE desactiva la suscripción; pendientes pasan a SUBSCRIPTION_INACTIVE sin envío.
Una petición ya en vuelo puede completarse: desactivar no retira bytes ya enviados.

## Secretos, rotación y SSRF

SoporteFlow conserva solamente su signing secret cifrado con V-B. Ninguna API key n8n.
POST /api/webhooks/[id]/rotate-secret?organizationId=<UUID> devuelve el nuevo secreto una vez.
Las intenciones antiguas conservan su versión anterior. Preparar ventana de dos claves
en el receptor; pausa operativa del procesador durante el intercambio si se necesita evitar
rechazos. Retirar la anterior solo tras drenar todas las entregas antiguas y su horizonte de retry.
No rotar dos veces antes de terminar esa transición: el ejemplo acepta máximo dos claves.
La rotación de la clave maestra de cifrado y su runbook completo siguen en 5.4W.

No hay excepción SSRF para n8n: HTTP, localhost, loopback IPv4/IPv6, RFC1918, link-local,
DNS mixto privado/público y redirects mantienen las prohibiciones V-B.
n8n local/Proxmox: publicar HTTPS mediante túnel o reverse proxy controlado con DNS/IP
públicos; el proxy preserva cuerpo y cabeceras y restringe acceso. No allowPrivate.
La clasificación DNS/IP y el pinning siguen en V-B para cada intento.

## Diagnóstico y fronteras

| Resultado             | Revisar                                                             |
| --------------------- | ------------------------------------------------------------------- |
| 401/403               | HMAC, reloj, secreto y permisos del receptor; no registrar secretos |
| 404                   | URL test/producción y workflow activo                               |
| 429                   | Capacidad del receptor y Retry-After                                |
| 5xx                   | Error del workflow o rechazo no manejado                            |
| TIMEOUT               | Respuesta dentro de 10s; aceptación durable                         |
| DNS_RESOLUTION_FAILED | DNS público resoluble                                               |
| SSRF_BLOCKED          | IP privada/reservada, sin excepción n8n                             |
| TLS_ERROR             | Certificado público válido para hostname                            |
| SUBSCRIPTION_INACTIVE | Suscripción desactivada                                             |

sla.* se entrega cuando el dominio produce el evento; el simple paso del tiempo no genera
breaches mientras no exista infraestructura programada.
Ver [runtime](../automation-runtime.md) para invocación, límites y deuda.
Sin REST n8n, creación/activación remota de workflows, email directo, shell, eval,
acción HTTP genérica, inbound privilegiado ni scheduler residente.
