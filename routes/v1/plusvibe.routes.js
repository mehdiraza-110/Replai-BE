const express = require("express");
const plusvibeController = require("../../controllers/plusvibe.controller");
const { plusvibeEndpoints } = require("../../config/plusvibe.endpoints");
const AuthGuard = require("../../middlewares/jwt.middleware");

const router = express.Router();
const allowedRoutes = [
  "/meta/endpoints",
  "/meta/status",
  ...plusvibeEndpoints.map((endpoint) => endpoint.expressPath),
];

const bindEndpoint = (endpoint) => {
  const method = endpoint.method.toLowerCase();

  router[method](endpoint.expressPath, (req, res) => {
    req.plusvibeEndpoint = endpoint;
    plusvibeController.forward(req, res);
  });
};

router.use(AuthGuard(allowedRoutes));

router.get("/meta/endpoints", plusvibeController.listEndpoints.bind(plusvibeController));
router.get("/meta/status", plusvibeController.getStatus.bind(plusvibeController));

plusvibeEndpoints.forEach(bindEndpoint);

module.exports = router;
