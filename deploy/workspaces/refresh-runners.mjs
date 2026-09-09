// Run inside the broker with `node --input-type=module < this-file` after
// rebuilding the workspace image. Only this node's labeled user containers
// are replaced. Their named home volumes and private networks are retained.
import { WorkspaceBroker } from '/opt/tm8/src/broker.mjs';
const broker = new WorkspaceBroker({ machineId: process.env.TM8_MACHINE_ID, image: process.env.TM8_RUNNER_IMAGE });
const image = await broker.docker.request('GET', `/images/${encodeURIComponent(broker.image)}/json`);
const filters = encodeURIComponent(JSON.stringify({ label: [`tm8.machine=${broker.machineId}`, 'tm8.kind=workspace'] }));
const containers = await broker.docker.request('GET', `/containers/json?all=true&filters=${filters}`);
for (const item of containers) {
  const container = await broker.docker.inspect(item.Id);
  const workspaceId = container.Config.Labels['tm8.workspace'], accountId = container.Config.Labels['tm8.account'];
  broker.assertOwner(container, workspaceId, accountId);
  if (container.Image === image.Id) continue;
  const name = broker.name(workspaceId);
  if (container.Name !== `/${name}` || container.Mounts.length !== 1 || container.Mounts[0].Type !== 'volume' || container.Mounts[0].Name !== `${name}-home`) throw new Error('Unexpected workspace storage; refusing replacement');
  const limits = { cpus: container.HostConfig.NanoCpus / 1e9, memoryMiB: container.HostConfig.Memory / 1024 / 1024, pids: container.HostConfig.PidsLimit };
  if (container.State.Running) await broker.docker.request('POST', `/containers/${name}/stop?t=10`);
  await broker.docker.request('DELETE', `/containers/${name}`);
  await broker.provision({ workspaceId, accountId, limits });
  console.log(`Updated ${name}; persistent home retained`);
}
