// E2E only, preloaded into the `next start` child (`--import`): resolve the test hostnames
// (*.site.test, *.other.test — RFC 6761 `.test`, never real) to loopback, so the Ops server's
// back channel reaches the local site fixture under the same origin the browser uses.
import dns from 'node:dns';

const TEST_HOST = /(^|\.)(site|other)\.test$/i;
const original = dns.lookup;

dns.lookup = function lookup(host, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (TEST_HOST.test(String(host))) {
    const all = typeof options === 'object' && options !== null && options.all;
    if (all) process.nextTick(callback, null, [{ address: '127.0.0.1', family: 4 }]);
    else process.nextTick(callback, null, '127.0.0.1', 4);
    return;
  }
  return original.call(dns, host, options, callback);
};
