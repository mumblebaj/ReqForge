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
const authType = document.querySelector("#authType");
const bodyType = document.querySelector("#bodyType");
const bodyEditor = document.querySelector("#bodyEditor");

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

  let body;
  if (bodyType.value !== "none" && !["GET"].includes(method)) {
    body = bodyEditor.value;
    if (bodyType.value === "json" && body.trim()) {
      JSON.parse(body);
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
    }
  }

  return {
    method,
    url: url.toString(),
    headers,
    body
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

function renderResponseResult(result) {
  responseTitle.textContent = result.ok ? "Completed" : `HTTP ${formatStatus(result)}`;
  statusCode.textContent = formatStatus(result);
  elapsedTime.textContent = `${result.elapsedMs || 0} ms`;
  responseBody.textContent = prettifyBody(result.body);
  responseHeaders.textContent = JSON.stringify(result.headers || {}, null, 2);
}

function showError(message, result = {}) {
  responseTitle.textContent = "Request error";
  statusCode.textContent = formatStatus(result);
  elapsedTime.textContent = result.elapsedMs !== undefined ? `${result.elapsedMs} ms` : "-- ms";
  responseBody.textContent = formatErrorMessage(message, result);
  responseHeaders.textContent = result.headers ? JSON.stringify(result.headers, null, 2) : "";
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
  responseTitle.textContent = "Not sent";
  statusCode.textContent = "--";
  elapsedTime.textContent = "-- ms";
  responseBody.textContent = "";
  responseHeaders.textContent = "";
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
requestForm.addEventListener("submit", sendRequest);
document.querySelector("#clearButton").addEventListener("click", clearRequest);

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
syncAuthFields();
