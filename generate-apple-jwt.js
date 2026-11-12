import jwt from 'jsonwebtoken';
import fs from 'fs';

// Substitua pelos seus dados reais da Apple Developer
const privateKey = fs.readFileSync('./AuthKey_DF4FG59TBS.p8'); // Nome do seu .p8
const teamId = '882XKXMS4F';
const clientId = 'com.meubolso.bolso'; // O seu Bundle ID
const keyId = 'DF4FG59TBS';

const token = jwt.sign({}, privateKey, {
  algorithm: 'ES256',
  expiresIn: '180d', // Validade máxima permitida pela Apple (6 meses)
  audience: 'https://appleid.apple.com',
  issuer: teamId,
  subject: clientId,
  keyid: keyId
});

console.log('\n--- SEU JWT DA APPLE ---');
console.log(token);
console.log('------------------------\n');