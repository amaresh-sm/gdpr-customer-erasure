import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import { config } from '../../config/src/index.js';

const kafka = new Kafka({ clientId: process.env.SERVICE_NAME ?? 'payflow', brokers: config().KAFKA_BROKERS.split(','), logLevel: logLevel.NOTHING });
export function producer(): Producer { return kafka.producer({ allowAutoTopicCreation: true }); }
export function consumer(groupId: string): Consumer { return kafka.consumer({ groupId, allowAutoTopicCreation: true }); }
export const DOMAIN_TOPIC = 'payflow.domain-events.v1';
export const DEAD_LETTER_TOPIC = 'payflow.dead-letter.v1';
