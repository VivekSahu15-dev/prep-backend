import { supabaseAdmin } from './supabase';
import { HttpError } from './errors';
import { publicUrl } from './images';

export async function collegeProfile(collegeId: string) {
  const [college, photos] = await Promise.all([
    supabaseAdmin
      .from('colleges')
      .select(
        'id, name, city, state, district, about, website, address, established_year, achievements, contact_name, contact_email, contact_phone'
      )
      .eq('id', collegeId)
      .single(),
    supabaseAdmin.from('college_photos').select('id, path').eq('college_id', collegeId).order('position'),
  ]);
  if (college.error || !college.data) throw new HttpError(404, 'College not found');
  const c: any = college.data;
  return {
    id: c.id as string,
    name: c.name as string,
    city: c.city as string,
    state: c.state as string,
    district: (c.district ?? null) as string | null,
    about: (c.about ?? null) as string | null,
    website: (c.website ?? null) as string | null,
    address: (c.address ?? null) as string | null,
    establishedYear: (c.established_year ?? null) as number | null,
    achievements: (c.achievements ?? []) as string[],
    contactName: (c.contact_name ?? null) as string | null,
    contactEmail: (c.contact_email ?? null) as string | null,
    contactPhone: (c.contact_phone ?? null) as string | null,
    photos: (photos.data ?? []).map((p: any) => ({ id: p.id as string, url: publicUrl('college-photos', p.path) })),
  };
}

export async function companyProfile(companyId: string) {
  const { data, error } = await supabaseAdmin
    .from('companies')
    .select('id, name, website, about, industry, company_size, founded_year, headquarters, linkedin_url, logo_path')
    .eq('id', companyId)
    .single();
  if (error || !data) throw new HttpError(404, 'Company not found');
  const c: any = data;
  return {
    id: c.id as string,
    name: c.name as string,
    website: (c.website ?? null) as string | null,
    about: (c.about ?? null) as string | null,
    industry: (c.industry ?? null) as string | null,
    companySize: (c.company_size ?? null) as string | null,
    foundedYear: (c.founded_year ?? null) as number | null,
    headquarters: (c.headquarters ?? null) as string | null,
    linkedinUrl: (c.linkedin_url ?? null) as string | null,
    logoUrl: c.logo_path ? publicUrl('company-logos', c.logo_path) : null,
  };
}