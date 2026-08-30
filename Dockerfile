# Use official lightweight Node.js image
FROM node:22-slim

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install --production

# Bundle app source
COPY . .

# Expose the port Cloud Run expects
ENV PORT=8080
EXPOSE 8080

# Start the application with OpenTelemetry pre-loaded
CMD [ "node", "--import", "./tracing.js", "server.js" ]