# sercopilot

Servicio de automatización para **Microsoft 365 Copilot** usando **Playwright + Microsoft Edge (InPrivate)**.
Permite iniciar sesión automáticamente (con un único paso manual de token/MFA), seleccionar el modelo y mantener un chat interactivo por consola, capturando las respuestas de Copilot en tiempo real.

---

## Requisitos

- Node.js 18+
- Microsoft Edge instalado

## Instalación

```bash
npm init -y
npm install playwright
npx playwright install msedge
```

## Ejecución

```bash
node copilot-service.js
```

> Recomendado: no dejes tus credenciales en el archivo. Expórtalas como variables de entorno:
> ```bash
> export COPILOT_EMAIL="tu_correo@dominio.com"
> export COPILOT_PASSWORD="tu_password"
> node copilot-service.js
> ```

## Comandos dentro del servicio

- Escribe un mensaje y pulsa ENTER para chatear.
- `/new`  -> inicia un chat nuevo (re-aplica el modelo configurado).
- `/exit` -> cierra el servicio.

---

## Cómo funciona

1. **Lanza Edge en modo InPrivate** (`--inprivate --guest`) con un contexto efímero y sin cookies, para que **siempre** se pida login (evita el problema de "sesión ya activa").
2. **Login automático**: escribe correo y contraseña.
3. **Único paso manual**: token / MFA (OTP por consola o aprobación en Authenticator).
4. **Maneja la pantalla "Acceso supervisado"** de Microsoft Defender for Cloud Apps (botón *Continuar en current browser*), que puede aparecer antes o después del login.
5. **Selecciona el modelo** configurado en `CONFIG.model`.
6. **Chat interactivo**: envía tu mensaje y captura la respuesta en directo.

---

## Selectores reales del DOM (verificados)

La captura de respuestas se basa en atributos `data-testid` reales del chat de Copilot:

| `data-testid`                 | Uso                                             |
|-------------------------------|-------------------------------------------------|
| `MessageListContainer`        | Contenedor de la lista de mensajes              |
| `m365-chat-llm-web-ui-chat-message` | Cada mensaje individual                    |
| `copilot-message-div`         | Contenedor de una respuesta de Copilot (contar) |
| `copilot-message-reply-div`   | Cuerpo de la respuesta (texto)                  |
| `lastChatMessage`             | Última respuesta                                |
| `loading-message`             | Presente mientras Copilot escribe (streaming)   |

**Nota importante:** los mensajes son `div[role="article"]` **sin `aria-label`**; el texto "Copilot said:" está en un `<h6>` interno. Por eso NO sirve `getByRole('article', { name: /copilot said/ })`; hay que usar los `data-testid`.

### Lógica de captura
1. Contar `copilot-message-div` antes de enviar.
2. Esperar a que aumente el conteo (nueva respuesta).
3. Esperar a que **desaparezca** `loading-message` (fin del streaming).
4. Estabilizar el texto de `lastChatMessage` (3 lecturas iguales).
5. Limpiar el prefijo "Copilot said:".

---

## Configuración

Edita el objeto `CONFIG` en `copilot-service.js`:

| Clave               | Descripción                                    |
|---------------------|------------------------------------------------|
| `url`               | URL del chat de Copilot                        |
| `email` / `password`| Credenciales (mejor por variables de entorno)  |
| `model`             | Nombre del modelo a seleccionar                |
| `headless`          | `false` para ver el navegador (necesario MFA)  |
| `loginMaxRetries`   | Reintentos del flujo de login                  |
| `responseTimeoutMs` | Tiempo máx. de espera por respuesta            |
