import MongoDatabase, { Config } from './database'
import { User, Tables, Database, Context, Channel, Random, pick, omit, TableType, Query, Eval } from 'koishi-core'
import { QuerySelector } from 'mongodb'

export * from './database'
export default MongoDatabase

declare module 'koishi-core' {
  interface Database {
    mongo: MongoDatabase
  }

  namespace Database {
    interface Statics {
      'koishi-plugin-mongo': typeof MongoDatabase
    }
  }

  interface Channel {
    type: Platform
    pid: string
  }
}

function escapeKey<T extends Partial<User>>(doc: T) {
  const data: T = { ...doc }
  delete data.timers
  delete data.usage
  if (doc.timers) {
    data.timers = {}
    for (const key in doc.timers) {
      if (key === '$date') data.timers._date = doc.timers.$date
      else data.timers[key.replace(/\./gmi, '_')] = doc.timers[key]
    }
  }
  if (doc.usage) {
    data.usage = {}
    for (const key in doc.usage) {
      if (key === '$date') data.usage._date = doc.usage.$date
      else data.usage[key.replace(/\./gmi, '_')] = doc.usage[key]
    }
  }
  return data
}

function unescapeKey<T extends Partial<User>>(data: T) {
  if (data.timers) {
    if (data.timers._date) {
      data.timers.$date = data.timers._date
      delete data.timers._date
    }
    for (const key in data.timers) {
      if (key.includes('_')) {
        data.timers[key.replace(/_/gmi, '.')] = data.timers[key]
        delete data.timers[key]
      }
    }
  }
  if (data.usage) {
    if (data.usage._date) {
      data.usage.$date = data.usage._date
      delete data.usage._date
    }
    for (const key in data.usage) {
      if (key.includes('_')) {
        data.usage[key.replace(/_/gmi, '.')] = data.usage[key]
        delete data.usage[key]
      }
    }
  }
  return data
}

function transformFieldQuery(query: Query.FieldQuery, key: string) {
  // shorthand syntax
  if (typeof query === 'string' || typeof query === 'number' || query instanceof Date) {
    return { $eq: query }
  } else if (Array.isArray(query)) {
    if (!query.length) return
    return { $in: query }
  } else if (query instanceof RegExp) {
    return { $regex: query }
  }

  // query operators
  const result: QuerySelector<any> = {}
  for (const prop in query) {
    if (prop === '$el') {
      result.$elemMatch = transformFieldQuery(query[prop], key)
    } else if (prop === '$regexFor') {
      result.$expr = {
        body(data: string, value: string) {
          return new RegExp(data, 'i').test(value)
        },
        args: ['$' + key, query],
        lang: 'js',
      }
    } else {
      result[prop] = query[prop]
    }
  }
  return result
}

function transformQuery(query: Query.Expr) {
  const filter = {}
  for (const key in query) {
    const value = query[key]
    if (key === '$and' || key === '$or') {
      // MongoError: $and/$or/$nor must be a nonempty array
      if (value.length) {
        filter[key] = value.map(transformQuery)
      } else if (key === '$or') {
        return { $nor: [{}] }
      }
    } else if (key === '$not') {
      // MongoError: unknown top level operator: $not
      // https://stackoverflow.com/questions/25270396/mongodb-how-to-invert-query-with-not
      filter['$nor'] = [transformQuery(value)]
    } else if (key === '$expr') {
      filter[key] = transformEval(value)
    } else {
      filter[key] = transformFieldQuery(value, key)
    }
  }
  return filter
}

function createFilter<T extends TableType>(name: T, _query: Query<T>) {
  const filter = transformQuery(Query.resolve(name, _query))
  const { primary } = Tables.config[name]
  if (filter[primary]) {
    filter['$or'] = [{ id: filter[primary] }, { _id: filter[primary] }]
    delete filter[primary]
  }
  return filter
}

function transformEval(expr: Eval.Numeric | Eval.Aggregation) {
  if (typeof expr === 'string') {
    return '$' + expr
  } else if (typeof expr === 'number' || typeof expr === 'boolean') {
    return expr
  }

  return Object.fromEntries(Object.entries(expr).map(([key, value]) => {
    if (Array.isArray(value)) {
      return [key, value.map(transformEval)]
    } else {
      return [key, transformEval(value)]
    }
  }))
}

Database.extend(MongoDatabase, {
  async drop(table?: TableType) {
    if (table) {
      await this.db.collection(table).drop()
    } else {
      const collections = await this.db.collections()
      await Promise.all(collections.map(c => c.drop()))
    }
  },

  async get(name, query, modifier) {
    const filter = createFilter(name, query)
    let cursor = this.db.collection(name).find(filter)
    const { fields, limit, offset = 0 } = Query.resolveModifier(modifier)
    if (fields) cursor = cursor.project(Object.fromEntries(fields.map(key => [key, 1])))
    if (offset) cursor = cursor.skip(offset)
    if (limit) cursor = cursor.limit(offset + limit)
    const data = await cursor.toArray()
    const { primary } = Tables.config[name]
    if (fields && fields.includes(primary as never)) {
      for (const item of data) {
        item[primary] ??= item._id
      }
    }
    return data
  },

  async remove(name, query) {
    const filter = createFilter(name, query)
    await this.db.collection(name).deleteMany(filter)
  },

  async create(name, data: any) {
    const meta = Tables.config[name]
    const { primary, type, fields } = meta
    const copy = { ...Tables.create(name), ...data }
    if (copy[primary]) {
      copy['_id'] = copy[primary]
    } else if (type === 'incremental') {
      const [latest] = await this.db.collection(name).find().sort('_id', -1).limit(1).toArray()
      let id = copy['_id'] = latest ? latest._id + 1 : 1
      if (Tables.Field.string.includes(fields[primary].type)) id = id.toString()
      copy[primary] = data[primary] = id
    } else if (type === 'random') {
      copy['_id'] = data[primary] = Random.uuid()
    }
    await this.db.collection(name).insertOne(copy).catch(() => {})
    return data
  },

  async update(name, data: any[], key: string) {
    if (!data.length) return
    const { primary } = Tables.config[name]
    if (!key || key === primary) key = '_id'
    const bulk = this.db.collection(name).initializeUnorderedBulkOp()
    for (const item of data) {
      bulk.find({ [key]: item[primary] }).updateOne({ $set: omit(item, [primary]) })
    }
    await bulk.execute()
  },

  async aggregate(name, fields, query) {
    const $match = createFilter(name, query)
    const [data] = await this.db.collection(name).aggregate([{ $match }, {
      $group: {
        _id: 1,
        ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, transformEval(value)])),
      },
    }]).toArray()
    return data
  },

  async getUser(type, id, modifier) {
    const { fields } = Query.resolveModifier(modifier)
    const applyDefault = (user: User) => ({
      ...pick(User.create(type, user[type]), fields),
      ...unescapeKey(user),
    })

    const data = await this.get('user', { [type]: id }, modifier)
    if (Array.isArray(id)) {
      return data.map(applyDefault)
    } else if (data[0]) {
      return { ...applyDefault(data[0]), [type]: id }
    }
  },

  async setUser(type, id, data) {
    delete data['id']
    await this.user.updateOne({ [type]: id }, { $set: escapeKey(data) })
  },

  async createUser(type, id, data) {
    await this.user.updateOne(
      { [type]: id },
      { $set: escapeKey(data), $setOnInsert: { id: Random.uuid() } },
      { upsert: true },
    )
  },

  async getChannel(type, pid, modifier) {
    modifier = Query.resolveModifier(modifier)
    const fields = (modifier?.fields ?? []).slice()
    const applyDefault = (channel: Channel) => ({
      ...pick(Channel.create(type, channel.pid), fields),
      ...omit(channel, ['type', 'pid']),
    })

    const index = fields.indexOf('id')
    if (Array.isArray(pid)) {
      const ids = pid.map(id => `${type}:${id}`)
      if (index >= 0) modifier.fields.splice(index, 1, 'type', 'pid')
      const data = await this.get('channel', { id: ids }, modifier)
      return data.map(applyDefault)
    } else {
      const id = `${type}:${pid}`
      if (index >= 0) modifier.fields.splice(index, 1)
      const data = await this.get('channel', id, modifier)
      return data[0] && { ...applyDefault(data[0]), id }
    }
  },

  async getAssignedChannels(_fields, assignMap = this.app.getSelfIds()) {
    const fields = (_fields ?? []).slice()
    const applyDefault = (channel: Channel) => ({
      ...pick(Channel.create(channel.type, channel.pid), _fields),
      ...omit(channel, ['type', 'pid']),
    })

    const index = fields.indexOf('id')
    if (index >= 0) fields.splice(index, 1, 'type', 'pid')
    const data = await this.get('channel', {
      $or: Object.entries(assignMap).map<any>(([type, assignee]) => ({ type, assignee })),
    }, fields)
    return data.map(applyDefault)
  },

  async setChannel(type, pid, data) {
    await this.channel.updateOne({ type, pid, id: `${type}:${pid}` }, { $set: data })
  },

  async createChannel(type, pid, data) {
    await this.channel.updateOne({ type, pid, id: `${type}:${pid}` }, {
      $set: Object.keys(data).length === 0 ? Channel.create(type, pid) : data,
    }, { upsert: true })
  },
})

export const name = 'mongo'

export function apply(ctx: Context, config: Config) {
  const db = new MongoDatabase(ctx.app, { host: 'localhost', name: 'koishi', protocol: 'mongodb', ...config })
  ctx.database = db as any
  ctx.before('connect', () => db.start())
  ctx.before('disconnect', () => db.stop())
}
