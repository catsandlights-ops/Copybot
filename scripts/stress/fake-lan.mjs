// Loaded into the app only by phone-check.mjs: pretends this machine is on a home network
// (a 192.168.x address), so phone pairing can make its link in a container. Not part of the app.
import os from 'node:os';
const real = os.networkInterfaces;
os.networkInterfaces = () => ({ ...real(), fakelan: [{ address: '192.168.77.1', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '192.168.77.1/24' }] });
