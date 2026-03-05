import net from "node:net";
import readline from "node:readline";

function jsonrpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonrpcError(id, code, message, data) {
  const payload = {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
  if (data !== undefined) {
    payload.error.data = data;
  }
  return payload;
}

function writeJsonLine(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`);
}

export function parseRpcEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error("rpc endpoint is required");
  }

  if (endpoint.startsWith("tcp://")) {
    const raw = endpoint.slice("tcp://".length);
    const [host, portText] = raw.split(":");
    const port = Number.parseInt(portText, 10);
    if (!host || !Number.isFinite(port) || port <= 0) {
      throw new Error(`invalid tcp rpc endpoint: ${endpoint}`);
    }
    return { kind: "tcp", host, port };
  }

  return { kind: "unix", path: endpoint };
}

export async function createJsonRpcServer({ endpoint, onRequest, onNotification }) {
  const parsedEndpoint = parseRpcEndpoint(endpoint);
  const server = net.createServer((socket) => {
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch (err) {
        writeJsonLine(socket, jsonrpcError(null, -32700, "Parse error", String(err)));
        return;
      }

      const isRequest = msg && typeof msg === "object" && "method" in msg && "id" in msg;
      const isNotification = msg && typeof msg === "object" && "method" in msg && !("id" in msg);
      if (!isRequest && !isNotification) {
        writeJsonLine(socket, jsonrpcError(msg?.id ?? null, -32600, "Invalid Request"));
        return;
      }

      if (isNotification) {
        if (onNotification) {
          try {
            await onNotification(msg.method, msg.params ?? null, { socket });
          } catch {
            // Notifications do not carry response.
          }
        }
        return;
      }

      try {
        const result = await onRequest(msg.method, msg.params ?? null, {
          id: msg.id,
          socket,
        });
        writeJsonLine(socket, jsonrpcResult(msg.id, result ?? null));
      } catch (err) {
        writeJsonLine(socket, jsonrpcError(msg.id, -32000, err?.message ?? "Internal error"));
      }
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);

    if (parsedEndpoint.kind === "unix") {
      server.listen(parsedEndpoint.path);
    } else {
      server.listen(parsedEndpoint.port, parsedEndpoint.host);
    }
  });

  return server;
}

export function callJsonRpc(endpoint, method, params = {}, options = {}) {
  const parsedEndpoint = parseRpcEndpoint(endpoint);
  const timeoutMs = options.timeoutMs ?? 5000;
  const requestId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  return new Promise((resolve, reject) => {
    const socket =
      parsedEndpoint.kind === "unix"
        ? net.createConnection(parsedEndpoint.path)
        : net.createConnection(parsedEndpoint.port, parsedEndpoint.host);
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(new Error(`rpc timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    function done(fn, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      rl.close();
      socket.destroy();
      fn(value);
    }

    socket.on("connect", () => {
      writeJsonLine(socket, {
        jsonrpc: "2.0",
        id: requestId,
        method,
        params,
      });
    });

    socket.on("error", (err) => {
      done(reject, err);
    });
    socket.on("close", () => {
      if (!settled) {
        done(reject, new Error("rpc connection closed"));
      }
    });

    rl.on("error", (err) => {
      done(reject, err);
    });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (msg?.id !== requestId) {
        return;
      }
      if (msg.error) {
        const err = new Error(msg.error.message || "rpc error");
        err.code = msg.error.code;
        err.data = msg.error.data;
        done(reject, err);
        return;
      }
      done(resolve, msg.result);
    });
  });
}
