const crypto = require('node:crypto');
const config = require('../config');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [, salt, hash] = stored.split('$');
    const expected = Buffer.from(hash, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

const b64url = buf => Buffer.from(buf).toString('base64url');
const sign = data => crypto.createHmac('sha256', config.SECRET).update(data).digest('base64url');

function createToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    sub: user.id, name: user.username, adm: !!user.is_admin, iat: now, exp: now + config.TOKEN_TTL,
  }));
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

function verifyToken(token) {
  try {
    const [header, payload, signature] = token.split('.');
    const expected = Buffer.from(sign(`${header}.${payload}`));
    const given = Buffer.from(signature || '');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return { id: data.sub, username: data.name, isAdmin: !!data.adm };
  } catch {
    return null;
  }
}

function userFromHeader(header) {
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  return verifyToken(header.slice(7).trim());
}

module.exports = { hashPassword, verifyPassword, createToken, verifyToken, userFromHeader };
