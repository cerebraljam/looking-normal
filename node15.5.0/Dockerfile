FROM node:15.5.0-alpine

RUN mkdir -p /app
WORKDIR /code
COPY package.json .
RUN npm install --quiet
EXPOSE 5000
COPY . ./code

ENV PORT=5000
ENV HOST=0.0.0.0
ENV SZLIMIT=3
ENV NZLIMIT=2

CMD ["npm", "run", "start"]
