import net from "node:net";

/**
 * 빈 port 후보 번호. 127.0.0.1:0에서 OS가 고른 번호를 읽고 바로 닫는다. 번호만이므로 다른 프로세스가 먼저 잡을 수 있다.
 * 그래서 이 번호는 후보일 뿐이고, 실제로 잡았는지는 그 port를 bind하는 쪽이 확인한다(embedded.ts `startEmbeddedCluster`).
 */
export function candidatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
