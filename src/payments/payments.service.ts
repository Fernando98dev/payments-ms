import { Inject, Injectable, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import Stripe from 'stripe';
import { NATS_SERVICE, envs } from '../config';
import { PaymentSessionDto } from './dto/payment-session.dto';
import { ClientProxy } from '@nestjs/microservices';

@Injectable()
export class PaymentsService {
    private readonly logger = new Logger('PaymentsService');

    private readonly stripe = new Stripe(
        envs.stripeSecret
    );

    constructor(
        @Inject(NATS_SERVICE) private readonly client: ClientProxy,
    ) { }

    async createPaymentSession(paymentSessionDto: PaymentSessionDto): Promise<any> {
        const { currency, items, orderId } = paymentSessionDto;

        const lineItems = items.map((item) => {
            return {
                price_data: {
                    currency: currency,
                    product_data: {
                        name: item.name,
                    },
                    unit_amount: Math.round(item.price * 100), // 20 dólares 2000 / 100 = 20.00 // 15.0000
                },
                quantity: item.quantity,
            };
        });

        const session = await this.stripe.checkout.sessions.create({
            // Colocar aquí el ID de mi orden
            payment_intent_data: {
                metadata: {
                    orderId: orderId
                },
            },
            line_items: lineItems,
            mode: 'payment',
            success_url: envs.stripeSuccessUrl,
            cancel_url: envs.stripeCancelUrl,
            metadata: {
                orderId: orderId
            }
        });

        // return session;
        return {
            cancelUrl: session.cancel_url,
            successUrl: session.success_url,
            url: session.url,
        }

    }

    async stripeWebhook(req: Request, res: Response) {
        const sig = req.headers['stripe-signature'];

        let event: ReturnType<typeof this.stripe.webhooks.constructEvent>;

        // Real
        const endpointSecret = envs.stripeEndpointSecret;

        try {
            event = this.stripe.webhooks.constructEvent(
                req['rawBody'],
                sig!,
                endpointSecret,
            );
        } catch (err: any) {
            this.logger.error(`Webhook Error: ${err.message}`);
            res.status(400).send(`Webhook Error: ${err.message}`);
            return;
        }

        this.logger.log(`Stripe Event Received: ${event.type}`);

        switch (event.type) {
            case 'checkout.session.completed':
                const checkoutSession = event.data.object as any;
                
                const payload = {
                    stripePaymentId: checkoutSession.payment_intent,
                    orderId: checkoutSession.metadata.orderId,
                    receiptUrl: checkoutSession.success_url,
                }

                this.logger.log(`Emitting order.paid from checkout.session.completed: ${payload.orderId}`);
                this.client.emit('order.paid', payload);
                break;

            case 'charge.succeeded':
                const chargeSucceeded = event.data.object as any;
                
                this.logger.log(`Charge Metadata: ${JSON.stringify(chargeSucceeded.metadata)}`);

                if (chargeSucceeded.metadata.orderId) {
                  const payload = {
                      stripePaymentId: chargeSucceeded.id,
                      orderId: chargeSucceeded.metadata.orderId,
                      receiptUrl: chargeSucceeded.receipt_url,
                  }
                  this.logger.log(`Emitting order.paid from charge.succeeded: ${payload.orderId}`);
                  this.client.emit('order.paid', payload);
                }

                break;

            default:
                this.logger.log(`Event ${event.type} not handled`);
        }

        return res.status(200).json({ sig });
    }
}
