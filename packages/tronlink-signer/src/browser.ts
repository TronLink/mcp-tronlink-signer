import open from "open";

export async function openApprovalPage(
  port: number,
  requestId: string
): Promise<void> {
  const url = `http://127.0.0.1:${port}/?requestId=${requestId}`;
  await open(url);
}
