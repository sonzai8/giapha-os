'use server'

import { revalidatePath } from 'next/cache'

import type { TranslationKey, TranslationValues } from '@/lib/i18n/messages'
import { getServerTranslations } from '@/lib/i18n/server'
import { Relationship } from '@/types'
import { getIsAdmin, getSupabase } from '@/utils/supabase/queries'

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Payload shape cho file backup JSON.
 * Các field DB-managed (created_at, updated_at) được giữ để tham khảo
 * nhưng sẽ bị loại bỏ khi import lại.
 */
interface PersonExport {
  id: string
  full_name: string
  gender: 'male' | 'female' | 'other'
  birth_year: number | null
  birth_month: number | null
  birth_day: number | null
  death_year: number | null
  death_month: number | null
  death_day: number | null
  death_lunar_year: number | null
  death_lunar_month: number | null
  death_lunar_day: number | null
  is_deceased: boolean
  is_in_law: boolean
  birth_order: number | null
  generation: number | null
  other_names: string | null
  avatar_url: string | null
  note: string | null
  // DB-managed fields (kept in export for traceability, stripped on import)
  created_at?: string
  updated_at?: string
}

interface RelationshipExport {
  id?: string
  type: string
  person_a: string
  person_b: string
  note?: string | null
  created_at?: string
  updated_at?: string
}

interface PersonDetailsPrivateExport {
  person_id: string
  phone_number: string | null
  occupation: string | null
  current_residence: string | null
}

interface CustomEventExport {
  id: string
  name: string
  content: string | null
  event_date: string
  location: string | null
  created_by: string | null
}

interface BackupPayload {
  version: number
  timestamp: string
  persons: PersonExport[]
  relationships: RelationshipExport[]
  person_details_private?: PersonDetailsPrivateExport[]
  custom_events?: CustomEventExport[]
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_PERSONS = 10000
const MAX_RELATIONSHIPS = 30000
const MAX_PRIVATE_DETAILS = 10000
const MAX_CUSTOM_EVENTS = 10000

function isShortText(value: unknown, maxLength: number) {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.length <= maxLength)
  )
}

type Translator = (key: TranslationKey, values?: TranslationValues) => string

function validateImportPayload(input: unknown, t: Translator): string | null {
  if (!input || typeof input !== 'object') return t('invalidData')
  const payload = input as Record<string, unknown>
  const persons = payload.persons
  const relationships = payload.relationships

  if (!Array.isArray(persons) || !Array.isArray(relationships)) {
    return t('invalidDataStructure')
  }
  if (persons.length === 0) return t('emptyBackup')
  if (persons.length > MAX_PERSONS)
    return t('tooManyPersons', { count: MAX_PERSONS })
  if (relationships.length > MAX_RELATIONSHIPS)
    return t('tooManyRelationships', { count: MAX_RELATIONSHIPS })

  const personIds = new Set<string>()
  for (const person of persons) {
    if (!person || typeof person !== 'object') return t('invalidPersonRecord')
    const row = person as Record<string, unknown>
    if (typeof row.id !== 'string' || !UUID_PATTERN.test(row.id))
      return t('invalidPersonId')
    if (personIds.has(row.id)) return t('duplicatePersonId')
    personIds.add(row.id)
    if (
      typeof row.full_name !== 'string' ||
      row.full_name.trim().length === 0 ||
      row.full_name.length > 200
    ) {
      return t('invalidPersonName')
    }
    if (!['male', 'female', 'other'].includes(String(row.gender)))
      return t('invalidGender')
    for (const field of ['other_names', 'avatar_url', 'note']) {
      if (!isShortText(row[field], 2000)) return t('fieldTooLong', { field })
    }
  }

  for (const relationship of relationships) {
    if (!relationship || typeof relationship !== 'object')
      return t('invalidRelationship')
    const row = relationship as Record<string, unknown>
    if (
      typeof row.person_a !== 'string' ||
      !personIds.has(row.person_a) ||
      typeof row.person_b !== 'string' ||
      !personIds.has(row.person_b) ||
      row.person_a === row.person_b ||
      !['marriage', 'biological_child', 'adopted_child'].includes(
        String(row.type)
      )
    )
      return t('invalidRelationshipData')
    if (!isShortText(row.note, 2000)) return t('relationshipNoteTooLong')
  }

  const privateDetails = payload.person_details_private
  if (privateDetails !== undefined) {
    if (
      !Array.isArray(privateDetails) ||
      privateDetails.length > MAX_PRIVATE_DETAILS
    ) {
      return t('privateDetailsLimit')
    }
    for (const detail of privateDetails) {
      if (!detail || typeof detail !== 'object')
        return t('invalidPrivateDetails')
      const row = detail as Record<string, unknown>
      if (typeof row.person_id !== 'string' || !personIds.has(row.person_id))
        return t('invalidPrivateDetailsPerson')
      for (const field of ['phone_number', 'occupation', 'current_residence']) {
        if (!isShortText(row[field], 500)) return t('fieldTooLong', { field })
      }
    }
  }

  const customEvents = payload.custom_events
  if (customEvents !== undefined) {
    if (
      !Array.isArray(customEvents) ||
      customEvents.length > MAX_CUSTOM_EVENTS
    ) {
      return t('eventsLimit')
    }
    for (const event of customEvents) {
      if (!event || typeof event !== 'object') return t('invalidEvent')
      const row = event as Record<string, unknown>
      if (typeof row.id !== 'string' || !UUID_PATTERN.test(row.id))
        return t('invalidEventId')
      if (
        typeof row.name !== 'string' ||
        row.name.trim().length === 0 ||
        row.name.length > 200
      )
        return t('invalidEventName')
      for (const field of ['content', 'location']) {
        if (!isShortText(row[field], 2000)) return t('fieldTooLong', { field })
      }
    }
  }
  return null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Các field được phép insert vào bảng persons (loại bỏ created_at/updated_at)
function sanitizePerson(
  p: PersonExport
): Omit<PersonExport, 'created_at' | 'updated_at'> {
  return {
    id: p.id,
    full_name: p.full_name,
    gender: p.gender,
    birth_year: p.birth_year ?? null,
    birth_month: p.birth_month ?? null,
    birth_day: p.birth_day ?? null,
    death_year: p.death_year ?? null,
    death_month: p.death_month ?? null,
    death_day: p.death_day ?? null,
    death_lunar_year: p.death_lunar_year ?? null,
    death_lunar_month: p.death_lunar_month ?? null,
    death_lunar_day: p.death_lunar_day ?? null,
    is_deceased: p.is_deceased ?? false,
    is_in_law: p.is_in_law ?? false,
    birth_order: p.birth_order ?? null,
    generation: p.generation ?? null,
    other_names: p.other_names ?? null,
    avatar_url: p.avatar_url ?? null,
    note: p.note ?? null
  }
}

function sanitizeRelationship(
  r: RelationshipExport
): Omit<RelationshipExport, 'id' | 'created_at' | 'updated_at'> {
  return {
    type: r.type,
    person_a: r.person_a,
    person_b: r.person_b,
    note: r.note ?? null
  }
}

function sanitizeCustomEvent(
  e: CustomEventExport
): Omit<CustomEventExport, 'created_by'> {
  return {
    id: e.id,
    name: e.name,
    content: e.content ?? null,
    event_date: e.event_date,
    location: e.location ?? null
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export async function exportData(
  exportRootId?: string
): Promise<BackupPayload | { error: string }> {
  const { t } = await getServerTranslations()
  const isAdmin = await getIsAdmin()
  if (!isAdmin) {
    return { error: t('dataAccessDenied') }
  }

  const supabase = await getSupabase()

  // Fetch ALL rows using pagination to avoid the 1000-row Supabase limit.
  const fetchAll = async <T>(
    table: string,
    selectCols: string,
    orderBy: string
  ): Promise<T[]> => {
    let allData: T[] = []
    let from = 0
    const step = 1000
    while (true) {
      const { data, error } = await supabase
        .from(table)
        .select(selectCols)
        .order(orderBy, { ascending: true })
        .range(from, from + step - 1)
      if (error) throw error
      if (!data || data.length === 0) break
      allData = allData.concat(data as T[])
      if (data.length < step) break
      from += step
    }
    return allData
  }

  let allPersons: PersonExport[] = []
  let allRels: RelationshipExport[] = []
  let allPrivateDetails: PersonDetailsPrivateExport[] = []
  let allCustomEvents: CustomEventExport[] = []

  try {
    allPersons = await fetchAll<PersonExport>(
      'persons',
      'id, full_name, gender, birth_year, birth_month, birth_day, death_year, death_month, death_day, death_lunar_year, death_lunar_month, death_lunar_day, is_deceased, is_in_law, birth_order, generation, other_names, avatar_url, note, created_at, updated_at',
      'created_at'
    )
    allRels = await fetchAll<RelationshipExport>(
      'relationships',
      'id, type, person_a, person_b, note, created_at, updated_at',
      'created_at'
    )
    // person_details_private might not have created_at, order by person_id
    allPrivateDetails = await fetchAll<PersonDetailsPrivateExport>(
      'person_details_private',
      'person_id, phone_number, occupation, current_residence',
      'person_id'
    )
    allCustomEvents = await fetchAll<CustomEventExport>(
      'custom_events',
      'id, name, content, event_date, location, created_by',
      'event_date'
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: t('loadDataError', { error: message }) }
  }

  let exportPersons = allPersons
  let exportRels = allRels
  let exportPrivateDetails = allPrivateDetails
  const exportCustomEvents = allCustomEvents

  // If a root person is selected, filter the export to only their subtree
  if (exportRootId && exportPersons.some((p) => p.id === exportRootId)) {
    const includedPersonIds = new Set<string>([exportRootId])

    // Pre-calculate adjacency lists for O(1) lookup to improve performance with large datasets
    const childrenMap = new Map<string, string[]>()
    const spouseMap = new Map<string, string[]>()

    exportRels.forEach((r) => {
      if (r.type === 'biological_child' || r.type === 'adopted_child') {
        if (!childrenMap.has(r.person_a)) childrenMap.set(r.person_a, [])
        childrenMap.get(r.person_a)!.push(r.person_b)
      } else if (r.type === 'marriage') {
        if (!spouseMap.has(r.person_a)) spouseMap.set(r.person_a, [])
        if (!spouseMap.has(r.person_b)) spouseMap.set(r.person_b, [])
        spouseMap.get(r.person_a)!.push(r.person_b)
        spouseMap.get(r.person_b)!.push(r.person_a)
      }
    })

    // 1. Traverse biological and adopted children recursively
    const findDescendants = (parentId: string) => {
      const children = childrenMap.get(parentId) || []
      children.forEach((childId) => {
        if (!includedPersonIds.has(childId)) {
          includedPersonIds.add(childId)
          findDescendants(childId)
        }
      })
    }
    findDescendants(exportRootId)

    // 2. Add spouses for everyone in the tree so far
    const descendantsArray = Array.from(includedPersonIds) // snapshot current members
    descendantsArray.forEach((personId) => {
      const spouses = spouseMap.get(personId) || []
      spouses.forEach((spouseId) => {
        includedPersonIds.add(spouseId)
      })
    })

    // 3. Filter the payload
    exportPersons = exportPersons.filter((p) => includedPersonIds.has(p.id))
    exportRels = exportRels.filter(
      (r) =>
        includedPersonIds.has(r.person_a) && includedPersonIds.has(r.person_b)
    )
    exportPrivateDetails = exportPrivateDetails.filter((d) =>
      includedPersonIds.has(d.person_id)
    )
    // custom_events are not person-scoped, so export all when subtree is selected
  }

  return {
    version: 3, // v3: adds death_lunar_*, person_details_private, relationship note, custom_events
    timestamp: new Date().toISOString(),
    persons: exportPersons,
    relationships: exportRels,
    person_details_private: exportPrivateDetails,
    custom_events: exportCustomEvents
  }
}

// ─── Import ───────────────────────────────────────────────────────────────────

export async function importData(
  importPayload:
    | BackupPayload
    | {
        persons: PersonExport[]
        relationships: Relationship[]
        person_details_private?: PersonDetailsPrivateExport[]
        custom_events?: CustomEventExport[]
      },
  mode: 'replace_all' | 'merge' = 'replace_all'
) {
  const { t } = await getServerTranslations()
  const isAdmin = await getIsAdmin()
  if (!isAdmin) {
    return { error: t('dataAccessDenied') }
  }

  const supabase = await getSupabase()

  const validationError = validateImportPayload(importPayload, t)
  if (validationError) return { error: validationError }

  if (mode === 'replace_all') {
    // 1. Xoá custom_events
    const { error: delEventsError } = await supabase
      .from('custom_events')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000')

    if (delEventsError)
      return {
        error: t('deleteEventsError', { error: delEventsError.message })
      }

    // 2. Xoá relationships (FK constraint)
    const { error: delRelError } = await supabase
      .from('relationships')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000')

    if (delRelError)
      return {
        error: t('deleteRelationshipsError', { error: delRelError.message })
      }

    // 3. Xoá person_details_private (FK constraint on persons)
    const { error: delPrivateError } = await supabase
      .from('person_details_private')
      .delete()
      .neq('person_id', '00000000-0000-0000-0000-000000000000')

    if (delPrivateError)
      return {
        error: t('deletePrivateDetailsError', {
          error: delPrivateError.message
        })
      }

    // 4. Xoá persons
    const { error: delPersonsError } = await supabase
      .from('persons')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000')

    if (delPersonsError)
      return {
        error: t('deletePersonsError', { error: delPersonsError.message })
      }
  } else {
    // Chế độ Merge: Chỉ xoá các relationships giữa các person nằm trong payload
    const importedPersonIds = Array.from(
      new Set(importPayload.persons.map((p) => p.id))
    )
    if (importedPersonIds.length > 0) {
      const { error: delRelError } = await supabase
        .from('relationships')
        .delete()
        .in('person_a', importedPersonIds)
        .in('person_b', importedPersonIds)

      if (delRelError)
        return {
          error: t('deleteRelationshipsError', { error: delRelError.message })
        }
    }
  }

  // 5. Insert persons (sanitized — chỉ giữ các field schema hiện tại)
  const CHUNK = 200
  const persons = importPayload.persons.map(sanitizePerson)

  for (let i = 0; i < persons.length; i += CHUNK) {
    const chunk = persons.slice(i, i + CHUNK)
    const { error } = await supabase.from('persons').upsert(chunk)
    if (error)
      return {
        error: t('importPersonsError', {
          chunk: i / CHUNK + 1,
          error: error.message
        })
      }
  }

  // 6. Insert relationships (stripped of id/created_at to avoid conflicts)
  // Filter out self-relationships to avoid "no_self_relationship" constraint violation
  const relationships = importPayload.relationships
    .filter((r) => r.person_a !== r.person_b)
    .map(sanitizeRelationship)

  for (let i = 0; i < relationships.length; i += CHUNK) {
    const chunk = relationships.slice(i, i + CHUNK)
    const { error } = await supabase.from('relationships').insert(chunk)
    if (error)
      return {
        error: t('importRelationshipsError', {
          chunk: i / CHUNK + 1,
          error: error.message
        })
      }
  }

  // 7. Insert person_details_private (if present in payload)
  let privateDetailsCount = 0
  const privateDetails = importPayload.person_details_private ?? []
  if (privateDetails.length > 0) {
    for (let i = 0; i < privateDetails.length; i += CHUNK) {
      const chunk = privateDetails.slice(i, i + CHUNK)
      const { error } = await supabase
        .from('person_details_private')
        .upsert(chunk)
      if (error)
        return {
          error: t('importPrivateDetailsError', {
            chunk: i / CHUNK + 1,
            error: error.message
          })
        }
    }
    privateDetailsCount = privateDetails.length
  }

  // 8. Insert custom_events (if present in payload, strip created_by)
  let customEventsCount = 0
  const customEvents = (importPayload.custom_events ?? []).map(
    sanitizeCustomEvent
  )
  if (customEvents.length > 0) {
    for (let i = 0; i < customEvents.length; i += CHUNK) {
      const chunk = customEvents.slice(i, i + CHUNK)
      const { error } = await supabase.from('custom_events').upsert(chunk)
      if (error)
        return {
          error: t('importEventsError', {
            chunk: i / CHUNK + 1,
            error: error.message
          })
        }
    }
    customEventsCount = customEvents.length
  }

  revalidatePath('/dashboard')
  revalidatePath('/dashboard/members')
  revalidatePath('/dashboard/data')

  return {
    success: true,
    imported: {
      persons: persons.length,
      relationships: relationships.length,
      person_details_private: privateDetailsCount,
      custom_events: customEventsCount
    }
  }
}
