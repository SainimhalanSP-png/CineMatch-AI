import 'dotenv/config';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

// Enable OpenTelemetry internal logger to output export status in the terminal
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter()
    }),
    instrumentations: [getNodeAutoInstrumentations()],
    serviceName: 'cinematch-ai-orchestrator'
});

sdk.start();
console.log('📡 OpenTelemetry Auto-Instrumentation started!');