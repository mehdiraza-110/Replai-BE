const { plusvibeConfig, validatePlusvibeConfig } = require("../config/plusvibe.integrations");
const { plusvibeEndpoints } = require("../config/plusvibe.endpoints");

class PlusvibeService {
  listEndpoints() {
    return plusvibeEndpoints;
  }

  async getStatus() {
    if (!plusvibeConfig.apiKey) {
      return {
        configured: false,
        apiStatus: "Missing API key",
        workspaceId: plusvibeConfig.workspaceId || null,
      };
    }

    const data = await this.request({
      endpoint: plusvibeEndpoints.find((endpoint) => endpoint.key === "workspace.getWorkspaces"),
      query: {},
      body: {},
      params: {},
    });

    return {
      configured: true,
      apiStatus: "Connected",
      workspaceId: plusvibeConfig.workspaceId || null,
      workspaces: data?.workspaces || [],
      raw: data,
    };
  }

  async request({ endpoint, query = {}, body = {}, params = {} }) {
    validatePlusvibeConfig();

    const method = endpoint.method.toUpperCase();
    const targetPath = this.replacePathParams(endpoint.path, params);
    const url = new URL(`${plusvibeConfig.baseUrl.replace(/\/$/, "")}${targetPath}`);
    const requestBody = this.buildBody(method, body);

    this.appendQuery(url, query);
    this.injectWorkspaceId(method, url, requestBody);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), plusvibeConfig.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": plusvibeConfig.apiKey,
        },
        body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(requestBody),
        signal: controller.signal,
      });

      const payload = await this.parseResponse(response);

      if (!response.ok) {
        const error = new Error(payload?.message || payload?.error || "Plusvibe request failed");
        error.statusCode = response.status;
        error.payload = payload;
        throw error;
      }

      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  replacePathParams(path, params) {
    return path.replace(/\{([^}]+)\}/g, (_, key) => {
      const value = params[key];

      if (!value) {
        throw new Error(`Missing path parameter: ${key}`);
      }

      return encodeURIComponent(value);
    });
  }

  buildBody(method, body) {
    if (method === "GET" || method === "HEAD") {
      return {};
    }

    return body && typeof body === "object" && !Array.isArray(body) ? { ...body } : body;
  }

  appendQuery(url, query) {
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") {
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((item) => url.searchParams.append(key, item));
        return;
      }

      url.searchParams.set(key, value);
    });
  }

  injectWorkspaceId(method, url, body) {
    if (!plusvibeConfig.workspaceId || url.searchParams.has("workspace_id")) {
      return;
    }

    if (method === "GET" || method === "HEAD") {
      url.searchParams.set("workspace_id", plusvibeConfig.workspaceId);
      return;
    }

    if (body && typeof body === "object" && !Array.isArray(body) && !body.workspace_id) {
      body.workspace_id = plusvibeConfig.workspaceId;
    }
  }

  async parseResponse(response) {
    const text = await response.text();

    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      return text;
    }
  }
}

module.exports = new PlusvibeService();
