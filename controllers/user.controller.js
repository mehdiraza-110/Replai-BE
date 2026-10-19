const userService = require('../services/user.service');
const jwtUtil = require('../utils/jwt.util');
const workspaceService = require('../services/workspace.service');
const { uploadToS3, deleteFromS3 } = require('../utils/s3.util');

class UserController {
  // Create a new user
  async createUser(req, res) {
    try {
      // Public signup: privileged fields (is_verified, is_admin_user) are never taken from the request body.
      const { first_name, last_name, email, phone, password, profile_image } = req.body;
      
      // Validation
      if (!email || !password) {
        return res.status(400).json({
          success: false,
          message: 'Email and password are required'
        });
      }
      
      // Check if user already exists
      const existingUser = await userService.getUserByEmail(email);
      if (existingUser) {
        return res.status(409).json({
          success: false,
          message: 'User with this email already exists'
        });
      }
      
      const userData = {
        first_name,
        last_name,
        email,
        phone,
        password,
        profile_image
      };
      
      const newUser = await userService.createUser(userData);
      
      // Remove password_hash from response
      delete newUser.password_hash;
      
      res.status(201).json({
        success: true,
        message: 'User created successfully',
        data: newUser
      });
    } catch (error) {
      console.error('Error creating user:', error);
      res.status(500).json({
        success: false,
        message: 'Error creating user',
        error: error.message
      });
    }
  }
  
  // Get all users
  async getAllUsers(req, res) {
    try {
      const users = await userService.getAllUsers();
      
      res.status(200).json({
        success: true,
        message: 'Users retrieved successfully',
        data: users,
        count: users.length
      });
    } catch (error) {
      console.error('Error fetching users:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching users',
        error: error.message
      });
    }
  }
  
  // Get user by ID
  async getUserById(req, res) {
    try {
      const { id } = req.params;
      const user = await userService.getUserById(id);
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      // Remove password_hash from response
      delete user.password_hash;
      
      res.status(200).json({
        success: true,
        message: 'User retrieved successfully',
        data: user
      });
    } catch (error) {
      console.error('Error fetching user:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching user',
        error: error.message
      });
    }
  }
  
  // Update user
  async updateUser(req, res) {
    try {
      const { id } = req.params;
      const updateData = req.body;
      
      // Don't allow updating password through this endpoint without proper validation
      // Password updates should be handled separately with proper verification
      
      const updatedUser = await userService.updateUser(id, updateData);
      
      // Remove password_hash from response
      delete updatedUser.password_hash;
      
      res.status(200).json({
        success: true,
        message: 'User updated successfully',
        data: updatedUser
      });
    } catch (error) {
      console.error('Error updating user:', error);
      
      if (error.message === 'User not found') {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      if (error.message === 'No fields to update') {
        return res.status(400).json({
          success: false,
          message: 'No fields to update'
        });
      }
      
      res.status(500).json({
        success: false,
        message: 'Error updating user',
        error: error.message
      });
    }
  }
  
  // Delete user (soft delete)
  async deleteUser(req, res) {
    try {
      const { id } = req.params;
      const result = await userService.deleteUser(id);
      
      res.status(200).json({
        success: true,
        message: result.message,
        data: { id: result.id }
      });
    } catch (error) {
      console.error('Error deleting user:', error);
      
      if (error.message === 'User not found') {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      res.status(500).json({
        success: false,
        message: 'Error deleting user',
        error: error.message
      });
    }
  }
  
  // Hard delete user (permanent delete)
  async hardDeleteUser(req, res) {
    try {
      const { id } = req.params;
      const result = await userService.hardDeleteUser(id);
      
      res.status(200).json({
        success: true,
        message: result.message,
        data: { id: result.id }
      });
    } catch (error) {
      console.error('Error hard deleting user:', error);
      
      if (error.message === 'User not found') {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      res.status(500).json({
        success: false,
        message: 'Error deleting user',
        error: error.message
      });
    }
  }
  
  // Login user
  async login(req, res) {
    try {
      const { email, password } = req.body;
      
      // Validation
      if (!email || !password) {
        return res.status(400).json({
          success: false,
          message: 'Email and password are required'
        });
      }
      
      const user = await userService.loginUser(email, password);
      
      // Create JWT token
      // The user's active workspace rides in the session. null for a brand-new user, who must create one first.
      const ctx = await workspaceService.resolveContext(user.id, null, null);
      const tokenData = {
        userId: user.id,
        email: user.email,
        roles: user.roles,
        workspaceId: ctx && ctx.workspace ? ctx.workspace.id : null
      };
      
      const token = await jwtUtil.createToken(tokenData);
      
      // Set token in HTTP-only cookie
      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 3600000 // 1 hour
      });
      
      res.status(200).json({
        success: true,
        message: 'Login successful',
        data: {
          user: {
            ...user,
            is_super_admin: Boolean(ctx && ctx.isSuperAdmin),
            workspaces: (ctx && ctx.memberships) || [],
            active_workspace_id: ctx && ctx.workspace ? ctx.workspace.id : null
          },
          token: token
        }
      });
    } catch (error) {
      console.error('Error logging in:', error);
      
      if (error.message === 'Invalid email or password') {
        return res.status(401).json({
          success: false,
          message: 'Invalid email or password'
        });
      }
      
      res.status(500).json({
        success: false,
        message: 'We could not sign you in right now. Please try again in a moment.'
      });
    }
  }
  
  // Sign out: clear the session cookie (same options as login so the browser actually removes it)
  async logout(req, res) {
    res.clearCookie('token', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });
    res.status(200).json({ success: true, message: 'Signed out successfully' });
  }

  // Current session user, fresh from the DB, in the same shape login returns (needs a valid token only)
  async me(req, res) {
    try {
      const user = await userService.getUserById(req.user.id);
      if (!user) {
        return res.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
      }
      delete user.password_hash;

      const ctx = await workspaceService.resolveContext(user.id, req.session && req.session.workspaceId, null);
      res.status(200).json({
        success: true,
        message: 'User retrieved successfully',
        data: {
          ...user,
          is_super_admin: Boolean(ctx && ctx.isSuperAdmin),
          workspaces: (ctx && ctx.memberships) || [],
          active_workspace_id: ctx && ctx.workspace ? ctx.workspace.id : null
        }
      });
    } catch (error) {
      console.error('Error fetching current user:', error);
      res.status(500).json({ success: false, message: 'We could not load your account right now. Please try again.' });
    }
  }

  // Update user profile (authenticated user's own profile)
  async updateProfile(req, res) {
    try {
      const userId = req.user?.id || req.params.id; // Use authenticated user ID or fallback to params
      const { first_name, last_name, email, phone } = req.body;
      
      const profileData = {
        first_name,
        last_name,
        email,
        phone
      };
      
      // Remove undefined fields
      Object.keys(profileData).forEach(key => 
        profileData[key] === undefined && delete profileData[key]
      );
      
      if (Object.keys(profileData).length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No fields to update'
        });
      }
      
      // Check if email is being updated and if it's already taken
      if (profileData.email) {
        const existingUser = await userService.getUserByEmail(profileData.email);
        if (existingUser && existingUser.id !== parseInt(userId)) {
          return res.status(409).json({
            success: false,
            message: 'Email is already taken by another user'
          });
        }
      }
      
      const updatedUser = await userService.updateProfile(userId, profileData);
      
      // Remove password_hash from response
      delete updatedUser.password_hash;
      
      res.status(200).json({
        success: true,
        message: 'Profile updated successfully',
        data: updatedUser
      });
    } catch (error) {
      console.error('Error updating profile:', error);
      
      if (error.message === 'User not found') {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      if (error.message === 'No fields to update') {
        return res.status(400).json({
          success: false,
          message: 'No fields to update'
        });
      }
      
      res.status(500).json({
        success: false,
        message: 'Error updating profile',
        error: error.message
      });
    }
  }
  
  // Change password (authenticated user's own account)
  async changePassword(req, res) {
    try {
      const userId = req.user?.id;
      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        return res.status(400).json({
          success: false,
          message: 'Current password and new password are required'
        });
      }

      if (String(newPassword).length < 8) {
        return res.status(400).json({
          success: false,
          message: 'New password must be at least 8 characters'
        });
      }

      const result = await userService.changePassword(userId, currentPassword, newPassword);

      res.status(200).json({
        success: true,
        message: result.message,
        data: null
      });
    } catch (error) {
      console.error('Error changing password:', error);

      if (error.message === 'User not found') {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      if (error.message === 'Current password is incorrect') {
        return res.status(401).json({
          success: false,
          message: 'Current password is incorrect'
        });
      }

      res.status(500).json({
        success: false,
        message: 'Error changing password',
        error: error.message
      });
    }
  }

  // Update user avatar
  async updateAvatar(req, res) {
    try {
      const userId = req.user?.id || req.params.id; // Use authenticated user ID or fallback to params
      
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'No file uploaded'
        });
      }
      
      // Get current user to check for existing avatar
      const currentUser = await userService.getUserById(userId);
      if (!currentUser) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      // Upload to S3
      const avatarUrl = await uploadToS3(req.file, 'avatars');
      
      // Delete old avatar from S3 if it exists
      if (currentUser.profile_image) {
        try {
          await deleteFromS3(currentUser.profile_image);
        } catch (deleteError) {
          console.error('Error deleting old avatar:', deleteError);
          // Continue even if deletion fails
        }
      }
      
      // Update user avatar in database
      const updatedUser = await userService.updateAvatar(userId, avatarUrl);
      
      // Remove password_hash from response
      delete updatedUser.password_hash;
      
      res.status(200).json({
        success: true,
        message: 'Avatar updated successfully',
        data: updatedUser
      });
    } catch (error) {
      console.error('Error updating avatar:', error);
      
      if (error.message === 'User not found') {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      res.status(500).json({
        success: false,
        message: 'Error updating avatar',
        error: error.message
      });
    }
  }
}

module.exports = new UserController();
