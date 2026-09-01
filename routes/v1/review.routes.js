const express = require("express");
const reviewController = require("../../controllers/review.controller");

const router = express.Router();

router.get("/", reviewController.listReviews);
router.get("/count", reviewController.countReviews);

module.exports = router;
