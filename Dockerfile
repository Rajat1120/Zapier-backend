FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm install typescript --save
RUN npm run build
EXPOSE 8080
CMD ["npm", "start"]