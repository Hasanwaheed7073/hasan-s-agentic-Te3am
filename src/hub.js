// Pushes live events to every open app tab. Nothing here is required for execution:
// the worker, queue and schedules run the same with no tab open.
const clients = new Set();

export function addClient(ws) {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
}

export function broadcast(event) {
  const data = JSON.stringify(event);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
}

export const hasClients = () => clients.size > 0;
