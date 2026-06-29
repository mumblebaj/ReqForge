const HEADER_PRESETS_KEY = "reqforge.headerPresets.v1";

const state = {
  activeTab: "params",
  activeResponseTab: "responseBody"
};

const rowTemplate = document.querySelector("#rowTemplate");
const requestForm = document.querySelector("#requestForm");
const sendButton = document.querySelector("#sendButton");
const responseTitle = document.querySelector("#responseTitle");
const statusCode = document.querySelector("#statusCode");
const elapsedTime = document.querySelector("#elapsedTime");
const responseBody = document.querySelector("#responseBody");
const responseHeaders = document.querySelector("#responseHeaders");
const responseDiagnostics = document.querySelector("#responseDiagnostics");
const authType = document.querySelector("#authType");
const bodyType = document.querySelector("#bodyType");
const bodyEditor = document.querySelector("#bodyEditor");
const proxyMode = document.querySelector("#proxyMode");
const manualProxyFields = document.querySelector("#manualProxyFields");

function addRow(tableId, key = "", value = "") {
  const table = document.querySelector(`#${tableId}`);
  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector('[data-field="key"]').value = key;
  row.querySelector('[data-field="value"]').value = value;
  row.querySelector("button").addEventListener("click", () => row.remove());
  table.append(row);
}

function readTable(tableId) {
  return Array.from(document.querySelectorAll(`#${tableId} .key-value-row`))
    .map((row) => ({
      key: row.querySelector('[data-field="key"]').value.trim(),
      value: row.querySelector('[data-field="value"]').value
    }))
    .filter((entry) => entry.key);
}

function writeTable(tableId, entries) {
  const table = document.querySelector(`#${tableId}`);
  table.innerHTML = "";
  entries.forEach((entry) => addRow(tableId, entry.key, entry.value));
  if (!entries.length) {
    addRow(tableId);
  }
}

function setTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll("[data-tab]").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${tabName}Panel`);
  });
}

function setResponseTab(tabId) {
  state.activeResponseTab = tabId;
  document.querySelectorAll("[data-response-tab]").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.responseTab === tabId);
  });
  document.querySelectorAll(".response-output").forEach((panel) => {
    panel.classList.toggle("active", panel.id === tabId);
  });
}

function syncAuthFields() {
  const selectedType = authType.value;
  document.querySelectorAll("[data-auth-fields]").forEach((section) => {
    const supportedTypes = section.dataset.authFields.split(" ");
    section.classList.toggle("active", supportedTypes.includes(selectedType));
  });
}

function syncProxyFields() {
  manualProxyFields.classList.toggle("active", proxyMode.value === "manual");
}

function getHeaderPresets() {
  try {
    const raw = localStorage.getItem(HEADER_PRESETS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setHeaderPresets(presets) {
  localStorage.setItem(HEADER_PRESETS_KEY, JSON.stringify(presets));
}

function refreshHeaderPresetSelect() {
  const select = document.querySelector("#headerPresetSelect");
  const presets = getHeaderPresets();
  const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = names.length ? "Select a preset" : "No presets yet";
  select.append(placeholder);

  names.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.append(option);
  });
}

function saveHeaderPreset() {
  const presetName = document.querySelector("#headerPresetName").value.trim();
  if (!presetName) {
    showError("Enter a preset name before saving.");
    return;
  }

  const presets = getHeaderPresets();
  presets[presetName] = readTable("headersTable");
  setHeaderPresets(presets);
  refreshHeaderPresetSelect();
  document.querySelector("#headerPresetSelect").value = presetName;
}

function loadHeaderPreset() {
  const selected = document.querySelector("#headerPresetSelect").value;
  if (!selected) {
    return;
  }

  const presets = getHeaderPresets();
  writeTable("headersTable", presets[selected] || []);
}

function deleteHeaderPreset() {
  const selected = document.querySelector("#headerPresetSelect").value;
  if (!selected) {
    return;
  }

  const presets = getHeaderPresets();
  delete presets[selected];
  setHeaderPresets(presets);
  refreshHeaderPresetSelect();
}

function applyAuth(headers, url) {
  switch (authType.value) {
    case "bearer":
    case "oauth2":
    case "jwt": {
      const token = document.querySelector("#tokenValue").value.trim();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      break;
    }
    case "basic": {
      const username = document.querySelector("#basicUsername").value;
      const password = document.querySelector("#basicPassword").value;
      if (username || password) {
        headers.Authorization = `Basic ${btoa(`${username}:${password}`)}`;
      }
      break;
    }
    case "apiKey": {
      const key = document.querySelector("#apiKeyName").value.trim();
      const value = document.querySelector("#apiKeyValue").value;
      const location = document.querySelector("#apiKeyLocation").value;
      if (key && value && location === "header") {
        headers[key] = value;
      }
      if (key && value && location === "query") {
        url.searchParams.set(key, value);
      }
      break;
    }
    default:
      break;
  }
}

function resolveHeaderVariables(headers) {
  // Allow reusing values from local storage via {{name}} placeholders.
  const variableStore = {};
  for (const [key, value] of Object.entries(localStorage)) {
    if (key.startsWith("reqforge.var.")) {
      variableStore[key.slice("reqforge.var.".length)] = value;
    }
  }

  const resolved = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    resolved[headerName] = String(headerValue).replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_, token) => {
      return variableStore[token] || "";
    });
  }

  return resolved;
}

function buildTransportSettings() {
  const mode = proxyMode.value;
  const bypassRaw = document.querySelector("#proxyBypassRules").value;
  const bypass = bypassRaw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const manualPacUrl = document.querySelector("#manualPacUrl").value.trim();

  const manualProxy = {
    protocol: document.querySelector("#manualProxyProtocol").value,
    host: document.querySelector("#manualProxyHost").value.trim(),
    port: Number(document.querySelector("#manualProxyPort").value || 0),
    authType: document.querySelector("#manualProxyAuthType").value,
    username: document.querySelector("#manualProxyUsername").value,
    password: document.querySelector("#manualProxyPassword").value,
    authToken: document.querySelector("#manualProxyAuthToken").value
  };

  return {
    mode,
    bypass,
    manualProxy,
    manualPacUrl,
    diagnostics: true
  };
}

function buildRequestPayload() {
  const method = document.querySelector("#method").value;
  const url = new URL(document.querySelector("#url").value);

  readTable("paramsTable").forEach(({ key, value }) => {
    url.searchParams.set(key, value);
  });

  const headers = {};
  readTable("headersTable").forEach(({ key, value }) => {
    headers[key] = value;
  });

  applyAuth(headers, url);
  const resolvedHeaders = resolveHeaderVariables(headers);

  let body;
  if (bodyType.value !== "none" && !["GET"].includes(method)) {
    body = bodyEditor.value;
    if (bodyType.value === "json" && body.trim()) {
      JSON.parse(body);
      resolvedHeaders["Content-Type"] = resolvedHeaders["Content-Type"] || "application/json";
    }
  }

  return {
    method,
    url: url.toString(),
    headers: resolvedHeaders,
    body,
    transport: buildTransportSettings()
  };
}

function prettifyBody(text) {
  if (!text) {
    return "";
  }

  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function setPending(isPending) {
  sendButton.disabled = isPending;
  sendButton.textContent = isPending ? "Sending" : "Send";
}

function formatErrorMessage(message, result = {}) {
  const details = result.errorDetails || [];

  if (!details.length) {
    return message;
  }

  return `${message}\n\nDetails:\n${details.map((detail) => `- ${detail}`).join("\n")}`;
}

function formatStatus(result) {
  if (!result || !result.status) {
    return "Error";
  }

  return [result.status, result.statusText].filter(Boolean).join(" ");
}

function formatDiagnostics(diagnostics) {
  if (!diagnostics) {
    return "No diagnostics returned.";
  }

  return JSON.stringify(diagnostics, null, 2);
}

function renderResponseResult(result) {
  responseTitle.textContent = result.ok ? "Completed" : `HTTP ${formatStatus(result)}`;
  statusCode.textContent = formatStatus(result);
  elapsedTime.textContent = `${result.elapsedMs || 0} ms`;
  responseBody.textContent = prettifyBody(result.body);
  responseHeaders.textContent = JSON.stringify(result.headers || {}, null, 2);
  responseDiagnostics.textContent = formatDiagnostics(result.diagnostics);
}

function showError(message, result = {}) {
  responseTitle.textContent = "Request error";
  statusCode.textContent = formatStatus(result);
  elapsedTime.textContent = result.elapsedMs !== undefined ? `${result.elapsedMs} ms` : "-- ms";
  responseBody.textContent = formatErrorMessage(message, result);
  responseHeaders.textContent = result.headers ? JSON.stringify(result.headers, null, 2) : "";
  responseDiagnostics.textContent = formatDiagnostics(result.diagnostics);
  setResponseTab("responseBody");
}

async function sendRequest(event) {
  event.preventDefault();
  setPending(true);
  responseTitle.textContent = "Sending";
  statusCode.textContent = "--";
  elapsedTime.textContent = "-- ms";
  responseBody.textContent = "";
  responseHeaders.textContent = "";
  responseDiagnostics.textContent = "";

  let requestPayload;
  try {
    requestPayload = buildRequestPayload();
  } catch (error) {
    showError(error.message);
    setPending(false);
    return;
  }

  try {
    const response = await fetch("/api/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestPayload)
    });

    const result = await response.json();
    if (!response.ok || result.error) {
      showError(result.error || result.body || "The request failed.", result);
      return;
    }

    renderResponseResult(result);
  } catch (error) {
    showError(error.message);
  } finally {
    setPending(false);
  }
}

function clearRequest() {
  document.querySelector("#method").value = "GET";
  document.querySelector("#url").value = "";
  writeTable("paramsTable", []);
  writeTable("headersTable", []);
  authType.value = "none";
  syncAuthFields();
  bodyType.value = "json";
  bodyEditor.value = "";

  proxyMode.value = "auto";
  syncProxyFields();
  document.querySelector("#manualProxyProtocol").value = "http";
  document.querySelector("#manualProxyHost").value = "";
  document.querySelector("#manualProxyPort").value = "";
  document.querySelector("#manualProxyAuthType").value = "none";
  document.querySelector("#manualProxyUsername").value = "";
  document.querySelector("#manualProxyPassword").value = "";
  document.querySelector("#manualProxyAuthToken").value = "";
  document.querySelector("#manualPacUrl").value = "";
  document.querySelector("#proxyBypassRules").value = "";

  responseTitle.textContent = "Not sent";
  statusCode.textContent = "--";
  elapsedTime.textContent = "-- ms";
  responseBody.textContent = "";
  responseHeaders.textContent = "";
  responseDiagnostics.textContent = "";
}

document.querySelectorAll("[data-tab]").forEach((tab) => {
  tab.addEventListener("click", () => setTab(tab.dataset.tab));
});

document.querySelectorAll("[data-response-tab]").forEach((tab) => {
  tab.addEventListener("click", () => setResponseTab(tab.dataset.responseTab));
});

document.querySelectorAll("[data-add-row]").forEach((button) => {
  button.addEventListener("click", () => addRow(button.dataset.addRow));
});

authType.addEventListener("change", syncAuthFields);
proxyMode.addEventListener("change", syncProxyFields);
requestForm.addEventListener("submit", sendRequest);
document.querySelector("#clearButton").addEventListener("click", clearRequest);

document.querySelector("#saveHeaderPresetButton").addEventListener("click", saveHeaderPreset);
document.querySelector("#loadHeaderPresetButton").addEventListener("click", loadHeaderPreset);
document.querySelector("#deleteHeaderPresetButton").addEventListener("click", deleteHeaderPreset);

document.querySelector("#formatJsonButton").addEventListener("click", () => {
  try {
    bodyEditor.value = JSON.stringify(JSON.parse(bodyEditor.value || "{}"), null, 2);
  } catch (error) {
    showError(error.message);
  }
});

bodyType.addEventListener("change", () => {
  const bodyEnabled = bodyType.value !== "none";
  bodyEditor.disabled = !bodyEnabled;
  document.querySelector("#formatJsonButton").disabled = bodyType.value !== "json";
});

writeTable("paramsTable", []);
writeTable("headersTable", [{ key: "Accept", value: "*/*" }]);
refreshHeaderPresetSelect();
syncAuthFields();
syncProxyFields();
