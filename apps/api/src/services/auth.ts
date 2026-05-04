import bcrypt from 'bcrypt';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { getDb } from '../db';

const SALT_ROUNDS = 10;

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set');
  }
  return secret;
}

function getJwtExpiresIn(): string {
  return process.env.JWT_EXPIRES_IN || '7d';
}

export interface TokenPayload {
  userId: string;
  username: string;
}

export const authService = {
  async createUser(username: string, password: string) {
    const db = getDb();
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await db
      .insertInto('users')
      .values({
        username,
        password: hashedPassword,
        active: true,
      })
      .returning(['id', 'username', 'active', 'created_at', 'updated_at'])
      .executeTakeFirstOrThrow();

    return result;
  },

  async findUserByUsername(username: string) {
    const db = getDb();
    return db
      .selectFrom('users')
      .selectAll()
      .where('username', '=', username)
      .executeTakeFirst();
  },

  async findUserById(id: string) {
    const db = getDb();
    return db
      .selectFrom('users')
      .select(['id', 'username', 'active', 'created_at', 'updated_at'])
      .where('id', '=', id)
      .executeTakeFirst();
  },

  async validatePassword(plainPassword: string, hashedPassword: string) {
    return bcrypt.compare(plainPassword, hashedPassword);
  },

  generateToken(payload: TokenPayload): string {
    const options: SignOptions = {
      expiresIn: getJwtExpiresIn() as SignOptions['expiresIn'],
    };
    return jwt.sign(payload, getJwtSecret(), options);
  },

  verifyToken(token: string): TokenPayload {
    return jwt.verify(token, getJwtSecret()) as TokenPayload;
  },
};
