const plusvibeService = require("../services/plusvibe.service");

class PlusvibeController {
  listEndpoints(req, res) {
    res.status(200).json({
      success: true,
      message: "Plusvibe endpoints retrieved successfully",
      data: plusvibeService.listEndpoints(),
    });
  }

  async getStatus(req, res) {
    try {
      const status = await plusvibeService.getStatus();

      res.status(200).json({
        success: true,
        message: "Plusvibe status retrieved successfully",
        data: status,
      });
    } catch (error) {
      this.handleError(res, error, "Error fetching Plusvibe status");
    }
  }

  async forward(req, res) {
    try {
      const data = await plusvibeService.request({
        endpoint: req.plusvibeEndpoint,
        query: req.query,
        body: req.body,
        params: req.params,
      });

      res.status(200).json({
        success: true,
        message: "Plusvibe request completed successfully",
        data,
      });
    } catch (error) {
      this.handleError(res, error, "Error forwarding Plusvibe request");
    }
  }

  handleError(res, error, fallbackMessage) {
    console.error(fallbackMessage, error);

    const statusCode = error.statusCode || (error.message?.startsWith("Missing") ? 400 : 500);

    res.status(statusCode).json({
      success: false,
      message: error.message || fallbackMessage,
      error: error.payload || error.message,
    });
  }
}

module.exports = new PlusvibeController();
