const { AnalyticsService } = require('./dist/services/analytics.service');
async function test() {
  try {
    const metrics1 = await AnalyticsService.getExecutiveMetrics(1);
    console.log('Company 1 Metrics:', metrics1);
    const metrics15 = await AnalyticsService.getExecutiveMetrics(15);
    console.log('Company 15 Metrics:', metrics15);
  } catch (e) {
    console.error(e);
  }
}
test();
