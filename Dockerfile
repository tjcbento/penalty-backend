# Use official Node.js LTS image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy app source code
COPY . .

# Create empty config folder
RUN mkdir -p config

# Expose port
EXPOSE 3000

# Run the app
CMD ["node", "server.js"]
