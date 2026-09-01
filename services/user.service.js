const db = require('../config/db.config');
const bcrypt = require('bcrypt');

class UserService {
  // Create a new user with admin role as default
  async createUser(userData) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      // Hash password
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(userData.password, saltRounds);
      
      // Insert user
      const userResult = await client.query(
        `INSERT INTO users (first_name, last_name, email, phone, password_hash, profile_image, is_verified, is_admin_user, created_at, updated_at, is_deleted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), FALSE)
         RETURNING id, first_name, last_name, email, phone, profile_image, is_verified, is_admin_user, created_at, updated_at`,
        [
          userData.first_name || null,
          userData.last_name || null,
          userData.email,
          userData.phone || '',
          passwordHash,
          userData.profile_image || null,
          userData.is_verified || false,
          userData.is_admin_user || false
        ]
      );
      
      const newUser = userResult.rows[0];
      
      // Get admin role ID
      const roleResult = await client.query(
        'SELECT id FROM roles WHERE name = $1',
        ['admin']
      );
      
      if (roleResult.rows.length === 0) {
        throw new Error('Admin role not found');
      }
      
      const adminRoleId = roleResult.rows[0].id;
      
      // Assign admin role to user
      await client.query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
        [newUser.id, adminRoleId]
      );
      
      await client.query('COMMIT');
      
      // Get user with roles
      const userWithRoles = await this.getUserById(newUser.id);
      
      return userWithRoles;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // Get all users
  async getAllUsers() {
    const result = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.profile_image, 
              u.is_verified, u.is_admin_user, u.created_at, u.updated_at,
              COALESCE(
                json_agg(
                  json_build_object('id', r.id, 'name', r.name)
                ) FILTER (WHERE r.id IS NOT NULL),
                '[]'::json
              ) as roles
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       WHERE u.is_deleted = FALSE OR u.is_deleted IS NULL
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    );
    
    return result.rows;
  }
  
  // Get user by ID
  async getUserById(userId) {
    const result = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.profile_image, 
              u.is_verified, u.is_admin_user, u.created_at, u.updated_at,
              COALESCE(
                json_agg(
                  json_build_object('id', r.id, 'name', r.name)
                ) FILTER (WHERE r.id IS NOT NULL),
                '[]'::json
              ) as roles
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       WHERE u.id = $1 AND (u.is_deleted = FALSE OR u.is_deleted IS NULL)
       GROUP BY u.id`,
      [userId]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return result.rows[0];
  }
  
  // Get user by email
  async getUserByEmail(email) {
    const result = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.password_hash, 
              u.profile_image, u.is_verified, u.is_admin_user, u.created_at, u.updated_at,
              COALESCE(
                json_agg(
                  json_build_object('id', r.id, 'name', r.name)
                ) FILTER (WHERE r.id IS NOT NULL),
                '[]'::json
              ) as roles
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       WHERE u.email = $1 AND (u.is_deleted = FALSE OR u.is_deleted IS NULL)
       GROUP BY u.id`,
      [email]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return result.rows[0];
  }
  
  // Update user
  async updateUser(userId, userData) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      // Build update query dynamically
      const updateFields = [];
      const values = [];
      let paramCount = 1;
      
      if (userData.first_name !== undefined) {
        updateFields.push(`first_name = $${paramCount++}`);
        values.push(userData.first_name);
      }
      if (userData.last_name !== undefined) {
        updateFields.push(`last_name = $${paramCount++}`);
        values.push(userData.last_name);
      }
      if (userData.email !== undefined) {
        updateFields.push(`email = $${paramCount++}`);
        values.push(userData.email);
      }
      if (userData.phone !== undefined) {
        updateFields.push(`phone = $${paramCount++}`);
        values.push(userData.phone);
      }
      if (userData.password !== undefined) {
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(userData.password, saltRounds);
        updateFields.push(`password_hash = $${paramCount++}`);
        values.push(passwordHash);
      }
      if (userData.profile_image !== undefined) {
        updateFields.push(`profile_image = $${paramCount++}`);
        values.push(userData.profile_image);
      }
      if (userData.is_verified !== undefined) {
        updateFields.push(`is_verified = $${paramCount++}`);
        values.push(userData.is_verified);
      }
      if (userData.is_admin_user !== undefined) {
        updateFields.push(`is_admin_user = $${paramCount++}`);
        values.push(userData.is_admin_user);
      }
      
      if (updateFields.length === 0) {
        await client.query('ROLLBACK');
        throw new Error('No fields to update');
      }
      
      updateFields.push(`updated_at = NOW()`);
      values.push(userId);
      
      const updateQuery = `
        UPDATE users 
        SET ${updateFields.join(', ')}
        WHERE id = $${paramCount} AND (is_deleted = FALSE OR is_deleted IS NULL)
        RETURNING id, first_name, last_name, email, phone, profile_image, is_verified, is_admin_user, created_at, updated_at
      `;
      
      const result = await client.query(updateQuery, values);
      
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error('User not found');
      }
      
      await client.query('COMMIT');
      
      // Get updated user with roles
      const updatedUser = await this.getUserById(userId);
      
      return updatedUser;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // Delete user (soft delete)
  async deleteUser(userId) {
    const result = await db.query(
      `UPDATE users 
       SET is_deleted = TRUE, updated_at = NOW()
       WHERE id = $1 AND (is_deleted = FALSE OR is_deleted IS NULL)
       RETURNING id`,
      [userId]
    );
    
    if (result.rows.length === 0) {
      throw new Error('User not found');
    }
    
    return { message: 'User deleted successfully', id: result.rows[0].id };
  }
  
  // Hard delete user (permanent delete)
  async hardDeleteUser(userId) {
    const result = await db.query(
      `DELETE FROM users WHERE id = $1 RETURNING id`,
      [userId]
    );
    
    if (result.rows.length === 0) {
      throw new Error('User not found');
    }
    
    return { message: 'User permanently deleted', id: result.rows[0].id };
  }
  
  // Login user - verify credentials
  async loginUser(email, password) {
    const user = await this.getUserByEmail(email);
    
    if (!user) {
      throw new Error('Invalid email or password');
    }
    
    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    
    if (!isPasswordValid) {
      throw new Error('Invalid email or password');
    }
    
    // Remove password_hash from response
    delete user.password_hash;
    
    return user;
  }
  
  // Update user profile (for authenticated user's own profile)
  async updateProfile(userId, profileData) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      // Build update query dynamically
      const updateFields = [];
      const values = [];
      let paramCount = 1;
      
      if (profileData.first_name !== undefined) {
        updateFields.push(`first_name = $${paramCount++}`);
        values.push(profileData.first_name);
      }
      if (profileData.last_name !== undefined) {
        updateFields.push(`last_name = $${paramCount++}`);
        values.push(profileData.last_name);
      }
      if (profileData.email !== undefined) {
        updateFields.push(`email = $${paramCount++}`);
        values.push(profileData.email);
      }
      if (profileData.phone !== undefined) {
        updateFields.push(`phone = $${paramCount++}`);
        values.push(profileData.phone);
      }
      
      if (updateFields.length === 0) {
        await client.query('ROLLBACK');
        throw new Error('No fields to update');
      }
      
      updateFields.push(`updated_at = NOW()`);
      values.push(userId);
      
      const updateQuery = `
        UPDATE users 
        SET ${updateFields.join(', ')}
        WHERE id = $${paramCount} AND (is_deleted = FALSE OR is_deleted IS NULL)
        RETURNING id, first_name, last_name, email, phone, profile_image, is_verified, is_admin_user, created_at, updated_at
      `;
      
      const result = await client.query(updateQuery, values);
      
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error('User not found');
      }
      
      await client.query('COMMIT');
      
      // Get updated user with roles
      const updatedUser = await this.getUserById(userId);
      
      return updatedUser;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // Change password (for authenticated user's own account)
  async changePassword(userId, currentPassword, newPassword) {
    const result = await db.query(
      `SELECT id, password_hash
       FROM users
       WHERE id = $1 AND (is_deleted = FALSE OR is_deleted IS NULL)`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('User not found');
    }

    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);

    if (!isCurrentPasswordValid) {
      throw new Error('Current password is incorrect');
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(newPassword, saltRounds);

    await db.query(
      `UPDATE users
       SET password_hash = $1, updated_at = NOW()
       WHERE id = $2`,
      [passwordHash, userId]
    );

    return { message: 'Password updated successfully' };
  }

  // Update user avatar
  async updateAvatar(userId, avatarUrl) {
    const result = await db.query(
      `UPDATE users 
       SET profile_image = $1, updated_at = NOW()
       WHERE id = $2 AND (is_deleted = FALSE OR is_deleted IS NULL)
       RETURNING id, first_name, last_name, email, phone, profile_image, is_verified, is_admin_user, created_at, updated_at`,
      [avatarUrl, userId]
    );
    
    if (result.rows.length === 0) {
      throw new Error('User not found');
    }
    
    // Get updated user with roles
    const updatedUser = await this.getUserById(userId);
    
    return updatedUser;
  }
}

module.exports = new UserService();
