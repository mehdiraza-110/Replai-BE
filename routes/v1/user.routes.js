const express = require('express');
const router = express.Router();
const userController = require('../../controllers/user.controller');
const { upload } = require('../../config/multer.config');
const AuthGuard = require('../../middlewares/jwt.middleware');
const SessionGuard = require('../../middlewares/session.middleware');
const SuperAdminGuard = require('../../middlewares/superAdmin.middleware');

// Login
router.post('/login', userController.login.bind(userController));
// Email OTP step of sign-in (public: the caller holds a challenge token, not a session yet)
router.post('/login/verify-otp', userController.verifyLoginOtp.bind(userController));
router.post('/login/resend-otp', userController.resendLoginOtp.bind(userController));

// Sign out (clears the cookie; works even with an expired/missing token) and current session user
router.post('/logout', userController.logout.bind(userController));
router.get('/me', SessionGuard, userController.me.bind(userController));

// Password reset (public). Registered before the "/:id" routes.
router.post('/forgot-password', userController.forgotPassword.bind(userController));
router.get('/reset-password/validate', userController.validateResetToken.bind(userController));
router.post('/reset-password', userController.resetPassword.bind(userController));

// Create a new user (public signup; privileged fields are ignored)
router.post('/', userController.createUser.bind(userController));

// Everything below that manages other users is super-admin only.
// Get all users
router.get('/', SuperAdminGuard, userController.getAllUsers.bind(userController));

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
router.get('/:id', SuperAdminGuard, userController.getUserById.bind(userController));

// Update user
router.put('/:id', SuperAdminGuard, userController.updateUser.bind(userController));
router.patch('/:id', SuperAdminGuard, userController.updateUser.bind(userController));

// Delete user (soft delete)
router.delete('/:id', SuperAdminGuard, userController.deleteUser.bind(userController));

// Hard delete user (permanent delete)
router.delete('/:id/hard', SuperAdminGuard, userController.hardDeleteUser.bind(userController));

module.exports = router;
