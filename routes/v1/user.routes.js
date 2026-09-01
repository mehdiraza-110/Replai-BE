const express = require('express');
const router = express.Router();
const userController = require('../../controllers/user.controller');
const { upload } = require('../../config/multer.config');
const AuthGuard = require('../../middlewares/jwt.middleware');

// Login
router.post('/login', userController.login.bind(userController));

// Create a new user
router.post('/', userController.createUser.bind(userController));

// Get all users
router.get('/', userController.getAllUsers.bind(userController));

// Update user profile (authenticated user's own profile)
// NOTE: these must be registered before the generic "/:id" routes below,
// otherwise Express matches "/:id" first with id="profile"/"avatar"/"password".
router.put('/profile', AuthGuard(['/profile']), userController.updateProfile.bind(userController));
router.patch('/profile', AuthGuard(['/profile']), userController.updateProfile.bind(userController));

// Update user avatar (authenticated user's own avatar)
router.put('/avatar', AuthGuard(['/avatar']), upload.single('avatar'), userController.updateAvatar.bind(userController));
router.patch('/avatar', AuthGuard(['/avatar']), upload.single('avatar'), userController.updateAvatar.bind(userController));

// Change password (authenticated user's own password)
router.put('/password', AuthGuard(['/password']), userController.changePassword.bind(userController));
router.patch('/password', AuthGuard(['/password']), userController.changePassword.bind(userController));

// Get user by ID
router.get('/:id', userController.getUserById.bind(userController));

// Update user
router.put('/:id', userController.updateUser.bind(userController));
router.patch('/:id', userController.updateUser.bind(userController));

// Delete user (soft delete)
router.delete('/:id', userController.deleteUser.bind(userController));

// Hard delete user (permanent delete)
router.delete('/:id/hard', userController.hardDeleteUser.bind(userController));

module.exports = router;
