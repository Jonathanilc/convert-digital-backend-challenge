const SWAGGER_UI_VERSION = '5.33.1';
const CDN = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}`;

/** Swagger UI for the HTTP contract, with a pointer to the AsyncAPI document for the socket. */
export function docsPage(title: string): string {
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
      .banner { font: 14px/1.5 system-ui, sans-serif; padding: 12px 20px; background: #f4f6f8; border-bottom: 1px solid #ddd; }
    </style>
  </head>
  <body>
    <div class="banner">
      HTTP API below. The real-time protocol is a WebSocket at <code>/ws</code>, documented in
      <a href="/asyncapi.yaml">asyncapi.yaml</a> (AsyncAPI 3).
    </div>
    <div id="swagger-ui"></div>
    <script src="${CDN}/swagger-ui-bundle.js" crossorigin="anonymous"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
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
