# ReqForge

ReqForge is a lightweight JavaScript API request builder for sending HTTP requests from a local browser app. It supports `GET`, `POST`, `PUT`, `PATCH`, and `DELETE` requests with query parameters, headers, authorization, and optional request payloads.

## Features

- Send `GET`, `POST`, `PUT`, `PATCH`, and `DELETE` requests.
- Add query parameters to the request URL.
- Add custom request headers.
- Add request authorization using Postman-style options.
- Send JSON or raw text payloads for supported methods.
- Format JSON payloads before sending.
- View response status, elapsed time, response body, and response headers.
- Uses a local Node.js proxy endpoint to avoid browser CORS limitations when calling APIs.

## Requirements

- Node.js 18 or newer

ReqForge uses only built-in Node.js APIs and does not require installing npm dependencies.

## Getting Started

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
Accept: application/json
Content-Type: application/json
X-Request-ID: demo-123
```

When the body type is `JSON`, ReqForge automatically adds `Content-Type: application/json` if no `Content-Type` header has already been provided.

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
  "body": "{ \"name\": \"Ada\" }"
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
  "elapsedMs": 120
}
```

Requests time out after 30 seconds by default. The proxy only supports `http://` and `https://` targets.

## Project Structure

```text
.
├── package.json
├── server.js
└── public
    ├── app.js
    ├── index.html
    └── styles.css
```

## Development

Run the app locally:

```powershell
npm run dev
```

The `dev` script currently starts the same Node.js server as `npm start`.
