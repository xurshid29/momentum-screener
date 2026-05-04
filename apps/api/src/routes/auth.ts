import { Router } from 'express';
import { z } from 'zod';
import { authService } from '../services/auth.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

const authSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(6).max(100),
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const result = authSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.errors });
    }

    const { username, password } = result.data;

    // Check if user already exists
    const existingUser = await authService.findUserByUsername(username);
    if (existingUser) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    const user = await authService.createUser(username, password);
    const token = authService.generateToken({ userId: user.id, username: user.username });

    res.status(201).json({
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          active: user.active,
          created_at: user.created_at,
          updated_at: user.updated_at,
        },
      },
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const result = authSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.errors });
    }

    const { username, password } = result.data;

    const user = await authService.findUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!user.active) {
      return res.status(401).json({ error: 'Account is disabled' });
    }

    const isValid = await authService.validatePassword(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = authService.generateToken({ userId: user.id, username: user.username });

    res.json({
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          active: user.active,
          created_at: user.created_at,
          updated_at: user.updated_at,
        },
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await authService.findUserById(req.user!.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ data: user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

export default router;
