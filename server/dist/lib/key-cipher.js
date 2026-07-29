import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
const PREFIX = 'enc:v1';
export class KeyCipher {
    key;
    constructor(secret) {
        this.key = secret ? createHash('sha256').update(secret, 'utf8').digest() : undefined;
    }
    get enabled() {
        return this.key !== undefined;
    }
    isEncrypted(value) {
        return value.startsWith(`${PREFIX}:`);
    }
    encrypt(value) {
        if (!this.key)
            return value;
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return [PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join(':');
    }
    decrypt(value) {
        if (!this.isEncrypted(value))
            return value;
        if (!this.key)
            throw new Error('数据文件包含加密的 API Key，请配置 API_KEY_ENCRYPTION_SECRET');
        const [, , ivValue, tagValue, encryptedValue] = value.split(':');
        if (!ivValue || !tagValue || !encryptedValue)
            throw new Error('API Key 加密数据格式损坏');
        try {
            const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivValue, 'base64url'));
            decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
            return Buffer.concat([
                decipher.update(Buffer.from(encryptedValue, 'base64url')),
                decipher.final()
            ]).toString('utf8');
        }
        catch {
            throw new Error('API Key 解密失败，请检查 API_KEY_ENCRYPTION_SECRET');
        }
    }
}
