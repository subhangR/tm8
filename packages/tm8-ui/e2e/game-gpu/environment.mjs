/** Host hardware evidence only. Never records environment variables, user names or credentials. */
import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { hardwareVendor } from './core.mjs';
const cmd = (name, args) => { try { return execFileSync(name, args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const read = async path => { try { return (await readFile(path, 'utf8')).trim(); } catch { return null; } };
const names = async path => { try { return await readdir(path); } catch { return []; } };
const accessible = async path => { try { await access(path, constants.R_OK | constants.W_OK); return true; } catch { return false; } };
export async function auditEnvironment() {
  const platform = os.platform(), devices = [], limitations = [];
  if (platform === 'linux') {
    for (const name of (await names('/dev/dri')).filter(n => /^renderD\d+$/.test(n))) {
      const root = `/sys/class/drm/${name}/device`, vendor = await read(`${root}/vendor`), device = await read(`${root}/device`);
      const vendorId = vendor ? Number(vendor) : null, deviceId = device ? Number(device) : null;
      devices.push({ name, path: `/dev/dri/${name}`, accessible: await accessible(`/dev/dri/${name}`), vendorId, deviceId,
        hardware: hardwareVendor(vendorId) });
    }
    limitations.push('Linux native eligibility requires an accessible DRM render node with recognized PCI vendor and matching Chromium device IDs. NVIDIA-only nodes without DRM are unverified.');
  } else if (platform === 'darwin') {
    const raw = cmd('system_profiler', ['SPDisplaysDataType', '-json']);
    try { for (const d of JSON.parse(raw ?? '{}').SPDisplaysDataType ?? []) devices.push({ name: d.sppci_model ?? d._name,
      accessible: Boolean(d.spdisplays_metal), hardware: Boolean(d.spdisplays_metal),
      vendorId: /apple/i.test(d.sppci_model ?? d._name ?? '') ? 0x106b : Number(/0x[\da-f]+/i.exec(d.spdisplays_vendor ?? '')?.[0]) || null, deviceId: null }); } catch {}
    limitations.push('macOS requires matching host/Chromium vendor and host model in Chromium device/renderer identity plus browser-reported driver version; missing driver proof remains unverified.');
  } else if (platform === 'win32') {
    const raw = cmd('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,PNPDeviceID | ConvertTo-Json -Compress']);
    try { const parsed = JSON.parse(raw ?? '[]'); for (const d of Array.isArray(parsed) ? parsed : [parsed]) {
      const ids = /VEN_([\dA-F]{4})&DEV_([\dA-F]{4})/i.exec(d.PNPDeviceID ?? '');
      const vendorId = ids ? parseInt(ids[1], 16) : null;
      devices.push({ name: d.Name, driverVersion: d.DriverVersion, vendorId, deviceId: ids ? parseInt(ids[2], 16) : null,
        accessible: Boolean(d.DriverVersion), hardware: hardwareVendor(vendorId) });
    } } catch {}
  } else limitations.push('Host hardware probe unsupported on this operating system.');
  const displayRefreshRatesHz = platform === 'linux' ? [...(cmd('xrandr', ['--current']) ?? '').matchAll(/([\d.]+)\*/g)].map(m => Number(m[1])) : [];
  limitations.push('Physical display refresh rate is only queried with Linux xrandr; unavailable values are null and never inferred from scene FPS.');
  return { platform, release: os.release(), arch: os.arch(), displayRefreshRatesHz, displayPresent: Boolean(process.env.DISPLAY),
    waylandPresent: Boolean(process.env.WAYLAND_DISPLAY), cpuCount: os.cpus().length, loadAverage: os.loadavg(), devices, limitations };
}
export function browserGpuSummary(info) {
  const gpu = info?.gpu;
  return { devices: (gpu?.devices ?? []).map(d => ({ vendorId: d.vendorId, deviceId: d.deviceId,
    vendorString: d.vendorString, deviceString: d.deviceString, driverVendor: d.driverVendor, driverVersion: d.driverVersion })),
    glRenderer: gpu?.auxAttributes?.glRenderer ?? null, glVendor: gpu?.auxAttributes?.glVendor ?? null,
    glVersion: gpu?.auxAttributes?.glVersion ?? null, displayType: gpu?.auxAttributes?.displayType ?? null,
    featureStatus: gpu?.featureStatus ?? {}, workarounds: gpu?.driverBugWorkarounds ?? [] };
}
