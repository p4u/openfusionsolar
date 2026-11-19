import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CookieJar, encryptPassword } from '../src/fusionsolar.js';

test('password is RSA-OAEP-SHA384 + version suffix', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const out = encryptPassword(publicKey.export({ type: 'spki', format: 'pem' }), 's3cret', 'V2');
  assert.ok(out.endsWith('V2'));
  const plain = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha384' },
    Buffer.from(out.slice(0, -2), 'base64'),
  );
  assert.equal(plain.toString(), 's3cret');
});

test('cookie jar scopes host-only and domain cookies', () => {
  const jar = new CookieJar();
  jar.store('eu5.fusionsolar.huawei.com', ['JSESSIONID=a; Path=/', 'dp-session=b; Domain=.fusionsolar.huawei.com; Secure']);
  assert.equal(jar.header('eu5.fusionsolar.huawei.com'), 'JSESSIONID=a; dp-session=b');
  assert.equal(jar.header('region01eu5.fusionsolar.huawei.com'), 'dp-session=b');
  jar.store('eu5.fusionsolar.huawei.com', ['JSESSIONID=; Max-Age=0']);
  assert.equal(jar.header('eu5.fusionsolar.huawei.com'), 'dp-session=b');
});
