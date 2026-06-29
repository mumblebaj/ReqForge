# ReqForge

ReqForge is a lightweight JavaScript API request builder for sending HTTP requests from a local browser app. It supports `GET`, `POST`, `PUT`, `PATCH`, and `DELETE` requests with query parameters, headers, authorization, and optional request payloads.

## Features

- Send `GET`, `POST`, `PUT`, `PATCH`, and `DELETE` requests.
- Add query parameters to the request URL.
- Add custom request headers.
- Save and reuse header presets from the Headers tab.
- Add request authorization using Postman-style options.
- Configure request transport with Proxy modes (`Auto`, `Environment`, `Manual`, `Direct`).
- Send JSON or raw text payloads for supported methods.
- Format JSON payloads before sending.
- View response status, elapsed time, response body, response headers, and proxy diagnostics.
- Uses a local Node.js proxy endpoint to avoid browser CORS limitations when calling APIs.

## Requirements

- Node.js 18 or newer
- pac-resolver v9.0.1
- Docker Desktop or another Docker runtime, when running ReqForge in a container

ReqForge uses only built-in Node.js APIs and does not require installing npm dependencies.

## Getting Started

Run:
```powershell
npm install
```
to install the pac-resolver dependency

Start the local server:

```powershell
npm start
```

Then open:

```text
http://localhost:3000
```

By default, the server listens on port `3000`. To use a different port:

```powershell
$env:PORT=4000; npm start
```

## Docker

Build the container image:

```powershell
docker build -t reqforge .
```

Run ReqForge on `http://localhost:3000`:

```powershell
docker run --rm -p 3000:3000 --name reqforge reqforge
```

To expose the app on a different host port, map that port to the container's port `3000`:

```powershell
docker run --rm -p 4000:3000 --name reqforge reqforge
```

Then open:

```text
http://localhost:4000
```

Stop the running container:

```powershell
docker stop reqforge
```

When calling APIs that are running on your host machine, use `host.docker.internal` instead of `localhost`. Inside a container, `localhost` refers to the container itself.

To run the container with a corporate proxy, pass proxy environment variables through to Node:

```powershell
docker run --rm -p 3000:3000 --name reqforge `
  -e HTTP_PROXY=$env:HTTP_PROXY `
  -e HTTPS_PROXY=$env:HTTPS_PROXY `
  -e NO_PROXY=$env:NO_PROXY `
  reqforge
```

## Request Builder

### Method

Choose one of the supported HTTP methods:

- `GET`
- `POST`
- `PUT`
- `PATCH`
- `DELETE`

`GET` requests do not send a request body. Other methods can send a payload when the body type is not set to `None`.

### URL

Enter an absolute API URL, for example:

```text
https://api.example.com/users
```

Only `http://` and `https://` URLs are supported.

### Query Params

Use the Params tab to add URL query parameters. Each enabled row is appended to the request URL before the request is sent.

For example:

```text
page=1
limit=25
```

produces:

```text
https://api.example.com/users?page=1&limit=25
```

### Headers

Use the Headers tab to add custom request headers.

Example headers:

```text
Accept: */*
Content-Type: application/json
X-Request-ID: demo-123
```

When the body type is `JSON`, ReqForge automatically adds `Content-Type: application/json` if no `Content-Type` header has already been provided.

ReqForge uses Postman-like defaults for outbound requests when you do not provide them yourself:

```text
Accept: */*
User-Agent: ReqForge/1.0
Cache-Control: no-cache
```

Headers controlled by the HTTP runtime, such as `Host`, `Content-Length`, and `Connection`, are not set manually by ReqForge.

The Headers tab includes preset actions:

- Save current headers as a named preset
- Load a saved preset
- Delete a saved preset

Preset data is stored in browser local storage.

Header values also support simple local substitutions with `{{name}}` placeholders. Placeholder values are read from local storage keys prefixed with `reqforge.var.`.

Example:

```text
X-Tenant-ID: {{tenantId}}
```

resolves from:

```text
localStorage key: reqforge.var.tenantId
```

### Proxy

Use the Proxy tab to control per-request transport behavior:

- `Auto (System then env)`: tries OS proxy detection first, then environment variables
- `Environment only`: uses `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`
- `Manual override`: specify protocol, host, port, auth settings, and bypass rules
- `Direct only`: bypasses all proxy sources

You can optionally provide a **Manual PAC URL** in the Proxy tab. When set, ReqForge evaluates that PAC script first and uses its `FindProxyForURL` result before falling back to environment proxy settings.

Bypass rules accept comma-separated hosts or domains.

Manual proxy auth supports these request-side values:

- `None`
- `Basic` (username and password)
- `Digest`, `NTLM`, and `Kerberos/Negotiate` token fields (forwarded as header token format)

## Authorization

ReqForge includes authorization options similar to common Postman workflows.

### No Auth

No authorization details are added to the request.

### Bearer Token

Adds an `Authorization` header:

```text
Authorization: Bearer <token>
```

### Basic Auth

Adds an `Authorization` header using a Base64-encoded username and password:

```text
Authorization: Basic <base64(username:password)>
```

### API Key

Adds an API key either as a request header or as a query parameter.

Header example:

```text
x-api-key: <value>
```

Query parameter example:

```text
https://api.example.com/users?api_key=<value>
```

### OAuth 2.0 Token

Adds the supplied token as a bearer token:

```text
Authorization: Bearer <token>
```

ReqForge does not currently perform a full OAuth login or token exchange flow. Paste an existing access token into the token field.

### JWT Bearer

Adds the supplied JWT as a bearer token:

```text
Authorization: Bearer <jwt>
```

## Request Body

The Body tab supports:

- `JSON`
- `Raw Text`
- `None`

JSON bodies are validated before sending. If the JSON is invalid, ReqForge shows the parse error and does not send the request.

Payloads are sent for `POST`, `PUT`, `PATCH`, and `DELETE` when body type is not `None`. `GET` requests ignore the body field.

## Response Viewer

After a request completes, ReqForge displays:

- HTTP status code and status text
- elapsed request time in milliseconds
- response body
- response headers
- diagnostics (proxy source, resolution steps, PAC/WPAD detection, auth method, and TLS details)

HTTP error responses from the target API, such as `400 Bad Request` or `401 Unauthorized`, are displayed as normal API responses with their original status code, response body, and response headers. Network or proxy-level failures are shown separately as request errors.

If ReqForge shows `502 Bad Gateway`, the local Node.js proxy failed before receiving a response from the target API. On corporate networks this can be caused by DNS, TLS inspection, VPN routing, or an outbound proxy requirement. ReqForge displays low-level failure details when Node provides them.

If the response body contains JSON, it is automatically formatted for readability.

## Local Proxy Endpoint

The browser UI sends all API calls through the local Node.js proxy:

```text
POST /api/request
```

The proxy accepts JSON in this shape:

```json
{
  "method": "POST",
  "url": "https://api.example.com/users",
  "headers": {
    "Accept": "application/json",
    "Content-Type": "application/json"
  },
  "body": "{ \"name\": \"Ada\" }",
  "transport": {
    "mode": "auto",
    "manualPacUrl": "http://proxy.example.com/wpad.dat",
    "bypass": ["localhost", ".internal.example.com"],
    "manualProxy": {
      "protocol": "http",
      "host": "proxy.example.com",
      "port": 8080,
      "authType": "basic",
      "username": "user",
      "password": "pass"
    }
  }
}
```

The proxy returns:

```json
{
  "ok": true,
  "status": 200,
  "statusText": "OK",
  "headers": {},
  "body": "{}",
  "transport": "http://proxy.example.com:8080",
  "diagnostics": {
    "source": "system-winhttp",
    "resolvedProxyForUrl": "http://proxy.example.com:8080"
  },
  "elapsedMs": 120
}
```

Requests time out after 30 seconds by default. The proxy only supports `http://` and `https://` targets.

## Corporate Proxy Support

ReqForge honors these environment variables from the Node.js server process:

```text
HTTP_PROXY
HTTPS_PROXY
NO_PROXY
```

Use `HTTP_PROXY` for plain HTTP targets and `HTTPS_PROXY` for HTTPS targets. `NO_PROXY` accepts comma-separated hosts or domains that should bypass the proxy, such as:

```text
localhost,127.0.0.1,.internal.example.com
```

ReqForge currently supports HTTP proxy URLs, including HTTPS targets through an HTTP `CONNECT` tunnel:

```text
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080
```

Current limitations:

- SOCKS proxy protocols are detectable/configurable but not yet executed by the runtime.
- WPAD auto-discovery is not implemented. Use OS proxy settings or the Manual PAC URL field.

Proxy credentials can be included in the proxy URL when your environment requires them:

```text
HTTPS_PROXY=http://username:password@proxy.example.com:8080
```

## Project Structure

```text
.
+-- Dockerfile
+-- package.json
+-- server.js
+-- public
    +-- app.js
    +-- index.html
    +-- styles.css
```

## Development

Run the app locally:

```powershell
npm run dev
```

The `dev` script currently starts the same Node.js server as `npm start`.
