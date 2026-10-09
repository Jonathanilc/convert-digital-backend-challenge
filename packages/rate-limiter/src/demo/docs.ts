/**
 * Swagger UI as a single static page. The assets come from a pinned CDN build so the API has
 * no extra runtime dependency; the page loads this server's own `/openapi.json`, and because the
 * document declares a relative `servers` URL, "Try it out" calls the same origin it was served from.
 */
const SWAGGER_UI_VERSION = '5.33.1';
const CDN = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}`;

export function swaggerUiPage(specUrl = '/openapi.json', title = 'Rate Limiter Demo API'): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · API docs</title>
    <link rel="stylesheet" href="${CDN}/swagger-ui.css" />
    <style>
      body { margin: 0; }
      .swagger-ui .topbar { display: none; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${CDN}/swagger-ui-bundle.js" crossorigin="anonymous"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '${specUrl}',
        dom_id: '#swagger-ui',
        deepLinking: true,
        displayRequestDuration: true,
        persistAuthorization: true,
        tryItOutEnabled: true,
      });
    </script>
  </body>
</html>
`;
}
