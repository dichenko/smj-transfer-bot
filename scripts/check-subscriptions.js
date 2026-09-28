import { config } from '../src/config.js';
import { MaxClient } from '../src/max-client.js';

const result = await new MaxClient(config.maxToken).request('/subscriptions');
for (const subscription of result.subscriptions ?? []) {
  console.log(JSON.stringify({ url: subscription.url, update_types: subscription.update_types }));
}
